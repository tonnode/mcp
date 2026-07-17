// Jetton/GRAM swaps via Omniston (STON.fi's RFQ aggregation protocol).
//
// Strictly non-custodial: get_swap_quote fetches a firm quote, build_swap_tx
// turns it into UNSIGNED TonConnect-ready messages. No key material ever
// touches this server — signing and sending stay with the wallet owner.
//
// Omniston is an external WebSocket service (no API key). Each tool call
// opens a fresh connection and closes it before returning; quote ids are
// stored by Omniston itself, so the two tools need no shared state here.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Omniston, WebSocketTransport, type Quote } from "@ston-fi/omniston-sdk";
import { fail, ok, parseAddress } from "./server.js";

const OMNISTON_URL = process.env.OMNISTON_API_URL ?? "wss://omni-ws.ston.fi";

// Omniston has no public testnet endpoint — a --testnet server quoting real
// mainnet swaps would be a trap. Explicit OMNISTON_API_URL overrides the block.
const TESTNET_BLOCKED =
  (process.env.TON_NETWORK === "testnet" || process.argv.includes("--testnet")) &&
  !process.env.OMNISTON_API_URL;

const QUOTE_WAIT_MS = 25_000;
const BUILD_TIMEOUT_MS = 15_000;
/** TonConnect chain id for TON mainnet — lets compliant wallets refuse to sign on the wrong network. */
const TONCONNECT_MAINNET = "-239";

// One socket per call is fine; hundreds at once from a single hosted IP is
// not. Excess callers fail fast instead of queueing into Omniston.
const MAX_CONCURRENT_CALLS = 8;
let activeCalls = 0;

/** Optional revenue share: fee (in bps of the output) paid to this address.
 * Both env vars must be valid or the fee is off — loudly, not silently. */
const INTEGRATOR = ((): { address: string; feePips: number } | null => {
  const addr = process.env.OMNISTON_INTEGRATOR_ADDRESS;
  const bpsRaw = process.env.OMNISTON_INTEGRATOR_FEE_BPS;
  if (!addr && !bpsRaw) return null;
  const bps = Number(bpsRaw);
  if (!addr || !bpsRaw || !Number.isInteger(bps) || bps <= 0 || bps > 5000) {
    console.error(
      "tonnode-mcp: integrator fee DISABLED — set both OMNISTON_INTEGRATOR_ADDRESS and OMNISTON_INTEGRATOR_FEE_BPS (integer bps, 1–5000)"
    );
    return null;
  }
  try {
    parseAddress(addr);
  } catch {
    console.error("tonnode-mcp: integrator fee DISABLED — OMNISTON_INTEGRATOR_ADDRESS is not a valid TON address");
    return null;
  }
  console.error(`tonnode-mcp: integrator fee active — ${bps} bps of swap output to ${addr}`);
  return { address: addr, feePips: bps * 100 };
})();

/**
 * The SDK's WebSocketTransport never attaches an "error" listener to the
 * socket. In Node (isomorphic-ws → the `ws` package, an EventEmitter) an
 * unhandled "error" emission — unreachable host, DNS failure, close() during
 * an in-flight dial — is an uncaught exception that kills the whole process.
 * The no-op listener defuses that; connect() still rejects with the real
 * error through the SDK's own "close" path.
 *
 * The SDK also feeds every raw frame to an unguarded JSON.parse inside an
 * rxjs handler, where a throw becomes an uncaught exception too. Filtering
 * next() keeps malformed frames from ever reaching it.
 */
class SafeWebSocketTransport extends WebSocketTransport {
  constructor(url: string) {
    super(url);
    const subject = this.messages as { next: (frame: string) => void };
    const origNext = subject.next.bind(subject);
    subject.next = (frame: string) => {
      try {
        JSON.parse(frame);
      } catch {
        console.error("tonnode-mcp: dropped malformed frame from Omniston");
        return;
      }
      origNext(frame);
    };
  }

  override connect(): Promise<void> {
    const promise = super.connect();
    // connect() assigns this.webSocket synchronously, so this lands on every dial
    (this as unknown as { webSocket?: { addEventListener?: (ev: string, fn: () => void) => void } })
      .webSocket?.addEventListener?.("error", () => {});
    return promise;
  }
}

type TonAsset = { chain: { $case: "ton"; value: { kind: { $case: "native"; value: {} } | { $case: "jetton"; value: string } } } };

/** "GRAM" / "TON" / "native" → the native coin; anything else must be a jetton master address. */
function parseAsset(raw: string): TonAsset {
  const s = raw.trim();
  if (/^(gram|ton|toncoin|native)$/i.test(s)) {
    return { chain: { $case: "ton", value: { kind: { $case: "native", value: {} } } } };
  }
  const addr = parseAddress(s);
  return { chain: { $case: "ton", value: { kind: { $case: "jetton", value: addr.toString() } } } };
}

function renderAsset(asset: { chain?: { $case: string; value?: { kind?: { $case: string; value?: unknown } } } } | undefined): string {
  const kind = asset?.chain?.value?.kind;
  if (!kind) return "?";
  return kind.$case === "native" ? "GRAM" : String(kind.value);
}

function parseUnits(raw: string, field: string): string {
  let v: bigint;
  try {
    v = BigInt(raw.trim());
  } catch {
    throw new Error(`${field} must be an integer amount in raw indivisible units, e.g. "1000000000"`);
  }
  if (v <= 0n) throw new Error(`${field} must be positive`);
  return v.toString();
}

function describeError(err: unknown): Error {
  if (err instanceof Error) {
    const details = (err as { details?: unknown }).details;
    if (details !== undefined && details !== null) {
      const text = typeof details === "string" ? details : JSON.stringify(details);
      return new Error(`${err.message} — ${text}`);
    }
    // the SDK rejects a refused/dropped dial with new Error(closeEvent.reason) — often ""
    if (!err.message.trim()) {
      return new Error("connection to the Omniston swap service failed — endpoint unreachable, retry shortly");
    }
    return err;
  }
  return new Error(String(err));
}

/** Run fn with a dedicated one-shot Omniston connection that always gets torn down.
 * No AutoReconnectTransport: a per-call connection has nothing to resume, and
 * dropping it removes the SDK's floating re-subscribe promise (an
 * unhandledRejection vector) while making dial failures reject immediately. */
async function withOmniston<T>(fn: (omni: Omniston) => Promise<T>): Promise<T> {
  if (activeCalls >= MAX_CONCURRENT_CALLS) {
    throw new Error("swap service is busy (too many concurrent quote/build calls) — retry in a few seconds");
  }
  activeCalls++;
  const omni = new Omniston({ apiUrl: OMNISTON_URL, transport: new SafeWebSocketTransport(OMNISTON_URL) });
  try {
    return await fn(omni);
  } finally {
    activeCalls--;
    try {
      omni.transport.close();
    } catch {
      // best-effort teardown — the result (or the real error) is already decided
    }
  }
}

function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Subscribe to the RFQ stream and resolve on the first firm quote. */
function firstQuote(omni: Omniston, request: Parameters<Omniston["requestForQuote"]>[0]): Promise<Quote> {
  return new Promise((resolve, reject) => {
    let sawNoQuote = false;
    const timer = setTimeout(() => {
      sub.unsubscribe();
      reject(
        new Error(
          sawNoQuote
            ? "no resolver quoted this pair/amount — pool may lack liquidity, or the amount is too small to cover gas"
            : `no quote within ${QUOTE_WAIT_MS / 1000}s — Omniston may be degraded, retry shortly`
        )
      );
    }, QUOTE_WAIT_MS);
    const sub = omni.requestForQuote(request).subscribe({
      next: (event) => {
        if (!("$case" in event)) return;
        if (event.$case === "quoteUpdated") {
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(event.value);
        } else if (event.$case === "noQuote") {
          // resolvers may still answer later in the window — keep waiting
          sawNoQuote = true;
        }
      },
      error: (err) => {
        clearTimeout(timer);
        reject(describeError(err));
      },
      complete: () => {
        clearTimeout(timer);
        reject(new Error("quote stream closed before any quote arrived"));
      },
    });
  });
}

const TESTNET_ERROR =
  "swap tools are mainnet-only (Omniston has no public testnet endpoint) — run without --testnet / TON_NETWORK=testnet";

const assetArg = z
  .string()
  .describe('"GRAM" for the native coin, or a jetton master address (e.g. USDT "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")');

export function registerSwapTools(server: McpServer): void {
  server.registerTool(
    "get_swap_quote",
    {
      title: "Swap quote",
      description:
        "Firm swap quote for exchanging GRAM or any jetton into another asset on TON, via the Omniston protocol (STON.fi RFQ aggregation over STON.fi/DeDust liquidity). MAINNET only. " +
        "Use when: an agent wants to know the current exchange terms, or as step 1 of an actual swap (step 2 is build_swap_tx with the returned quote_id). " +
        "Amounts are raw indivisible units — GRAM has 9 decimals (1 GRAM = 1e9), USDT has 6; read a jetton's decimals via run_get_method get_jetton_data if unsure. " +
        "Returns: quote_id (pass it to build_swap_tx PROMPTLY — quotes expire in about a minute), input/output amounts, " +
        "min_output_units (the on-chain slippage floor the swap will be built with — the only guaranteed minimum), price_impact_bps, " +
        "integrator_fee_units (revenue share of the server operator, if configured — already deducted from output_units), " +
        "gas_budget_nano (GRAM the wallet must additionally hold for gas) and the DEX route. " +
        "This is a price lookup only — nothing is signed or sent.",
      inputSchema: {
        from_asset: assetArg,
        to_asset: assetArg,
        amount_units: z
          .string()
          .describe('Amount in raw indivisible units of the "exact" side, e.g. "1000000000" = 1 GRAM'),
        exact: z
          .enum(["input", "output"])
          .default("input")
          .describe(
            "Which side amount_units fixes: input = spend exactly this much; output = target receiving this much after fees " +
              "(the guaranteed on-chain floor is still min_output_units — top up amount_units or tighten slippage_bps when an exact minimum must clear)"
          ),
        slippage_bps: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(100)
          .describe("Max price slippage in basis points, 1–500 (default 100 = 1%). The cap is deliberate: quotes here are firm, higher slippage only feeds MEV"),
      },
      outputSchema: {
        quote_id: z.string(),
        resolver: z.string(),
        input_asset: z.string(),
        output_asset: z.string(),
        input_units: z.string(),
        output_units: z.string(),
        min_output_units: z.string(),
        recommended_min_output_units: z.string(),
        recommended_slippage_bps: z.number(),
        price_impact_bps: z.number().nullable(),
        protocol_fee_units: z.string(),
        integrator_fee_units: z.string(),
        gas_budget_nano: z.string().nullable(),
        estimated_settlement_seconds: z.number().nullable(),
        route: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            protocols: z.array(z.string()),
          })
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ from_asset, to_asset, amount_units, exact, slippage_bps }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const inputAsset = parseAsset(from_asset);
        const outputAsset = parseAsset(to_asset);
        if (renderAsset(inputAsset) === renderAsset(outputAsset)) {
          throw new Error("from_asset and to_asset are the same asset");
        }
        const units = parseUnits(amount_units, "amount_units");

        const quote = await withOmniston((omni) =>
          firstQuote(omni, {
            inputAsset,
            outputAsset,
            amount:
              exact === "output"
                ? { $case: "outputUnits", value: units }
                : { $case: "inputUnits", value: units },
            settlementParams: [
              { params: { $case: "swap", value: { maxPriceSlippagePips: slippage_bps * 100 } } },
            ],
            ...(INTEGRATOR
              ? {
                  integratorAddress: { chain: { $case: "ton" as const, value: INTEGRATOR.address } },
                  integratorFeePips: INTEGRATOR.feePips,
                }
              : {}),
          })
        );

        const swap = quote.settlementData?.$case === "swap" ? quote.settlementData.value : null;
        if (!swap) throw new Error(`unexpected settlement type "${quote.settlementData?.$case}" — expected swap`);

        return ok({
          quote_id: quote.quoteId,
          resolver: quote.resolverName,
          input_asset: renderAsset(quote.inputAsset as never),
          output_asset: renderAsset(quote.outputAsset as never),
          input_units: quote.inputUnits,
          output_units: quote.outputUnits,
          min_output_units: swap.minOutputAmount,
          recommended_min_output_units: swap.recommendedMinOutputAmount,
          recommended_slippage_bps: Math.round(swap.recommendedSlippagePips / 100),
          price_impact_bps:
            swap.priceImpactPips !== undefined ? Math.round(swap.priceImpactPips / 100) : null,
          protocol_fee_units: quote.protocolFeeUnits,
          integrator_fee_units: quote.integratorFeeUnits,
          gas_budget_nano: quote.gasBudget ?? null,
          estimated_settlement_seconds: quote.estimatedSettlementDuration ?? null,
          route: swap.routes.flatMap((r) =>
            r.steps.map((s) => ({
              from: renderAsset(s.inputAsset as never),
              to: renderAsset(s.outputAsset as never),
              protocols: [...new Set(s.chunks.map((c) => c.protocol))],
            }))
          ),
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "build_swap_tx",
    {
      title: "Build swap transaction",
      description:
        "Build the UNSIGNED transaction for a swap quoted by get_swap_quote. Non-custodial: this returns TonConnect-ready messages — " +
        "nothing is signed and nothing is sent; the wallet owner signs and broadcasts them (e.g. tonConnectUi.sendTransaction(result.tonconnect)). " +
        "The messages MOVE REAL FUNDS once signed, so treat the output as an armed payment and show it to the wallet owner before sending. " +
        "Use when: an agent (or the app driving it) actually wants to execute the swap after inspecting the quote. " +
        "Args: quote_id from get_swap_quote (use it promptly — expired quotes fail and need a re-quote) and wallet — the address that will send the transaction, " +
        "receive the swap output and any gas excess. " +
        "Returns: tonconnect {validUntil, network, messages[{address, amount, payload, stateInit?}]} with base64 BoC payloads, exactly the shape TonConnect sendTransaction expects. " +
        "Omniston emulates the transfer while building — if the wallet lacks the input funds, this fails up front. " +
        "The wallet must hold the input amount (for GRAM swaps it is included in the attached value) plus the quote's gas_budget_nano in GRAM.",
      inputSchema: {
        quote_id: z.string().describe("Quote id returned by get_swap_quote"),
        wallet: z
          .string()
          .describe("TON address that will sign and send the swap (also receives output and gas excess)"),
        use_recommended_slippage: z
          .boolean()
          .default(false)
          .describe(
            "true = build with Omniston's recommended slippage floor (recommended_min_output_units) instead of the floor from your quote request — it can be LOOSER than what you asked for"
          ),
      },
      outputSchema: {
        quote_id: z.string(),
        wallet: z.string(),
        message_count: z.number(),
        total_attached_nano: z.string(),
        tonconnect: z.object({
          validUntil: z.number(),
          network: z.string(),
          messages: z.array(
            z.object({
              address: z.string(),
              amount: z.string(),
              payload: z.string(),
              stateInit: z.string().optional(),
            })
          ),
        }),
      },
      // not readOnly: the output is an armed, fund-moving artifact — clients
      // that auto-approve read-only tools must still gate this one
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id, wallet, use_recommended_slippage }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const addr = parseAddress(wallet);
        const id = quote_id.trim();
        if (!/^[0-9a-f]{64}$/i.test(id)) {
          throw new Error("quote_id must be the 64-char hex id returned by get_swap_quote");
        }

        const tx = await withOmniston((omni) =>
          withDeadline(
            omni.tonBuildSwap({
              quoteId: id,
              transferSrcAddress: { chain: { $case: "ton", value: addr.toString() } },
              useRecommendedSlippage: use_recommended_slippage,
            }),
            BUILD_TIMEOUT_MS,
            "building the swap transaction"
          )
        );

        if (!tx.messages.length) throw new Error("Omniston returned no messages for this quote");

        const messages = tx.messages.map((m) => ({
          address: m.targetAddress,
          amount: m.sendAmount,
          payload: Buffer.from(m.payload, "hex").toString("base64"),
          ...(m.jettonWalletStateInit
            ? { stateInit: Buffer.from(m.jettonWalletStateInit, "hex").toString("base64") }
            : {}),
        }));
        const total = tx.messages.reduce((sum, m) => sum + BigInt(m.sendAmount), 0n);

        return ok({
          quote_id: id,
          wallet: addr.toString({ bounceable: false }),
          message_count: messages.length,
          total_attached_nano: total.toString(),
          tonconnect: {
            validUntil: Math.floor(Date.now() / 1000) + 300,
            network: TONCONNECT_MAINNET,
            messages,
          },
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );
}
