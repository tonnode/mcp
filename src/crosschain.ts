// Cross-chain swaps: TON → EVM chains via Omniston's HTLC escrow settlement
// (v1beta8 "order" flow). TON is always the SOURCE chain here — the signer is
// a TON wallet; swaps FROM an EVM chain would need an EVM signer and are out
// of scope for this server.
//
// The atomic-swap lifecycle an agent drives:
//   1. get_crosschain_quote      — firm RFQ quote (order/HTLC settlement)
//   2. build_crosschain_swap_tx  — unsigned TON escrow transfer + a fresh
//      HTLC secret. The SECRET IS RETURNED TO THE CALLER and not stored here.
//   3. wallet owner signs & sends (TonConnect) → escrow position on TON
//   4. track_crosschain_swap     — poll until the resolver's destination
//      position is ready for completion
//   5. disclose_crosschain_secret — reveal the secret; both sides settle.
//      The tool re-verifies on-chain state first: order exists, the
//      DESTINATION position is ready, and the secret matches the position's
//      hash — prose warnings alone must not guard fund-loss paths.
//   fallback: build_crosschain_refund — reclaim funds if the trade stalls
//
// Non-custodial: the server never signs, never holds funds, and forgets the
// secret the moment the tool call returns. Disclosing a secret can only
// COMPLETE the trade as quoted — it cannot redirect funds anywhere else.

import { randomBytes } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Omniston, Order } from "@ston-fi/omniston-sdk";
import { fail, ok, parseAddress } from "./server.js";
import {
  BUILD_TIMEOUT_MS,
  TESTNET_BLOCKED,
  TESTNET_ERROR,
  describeError,
  firstQuote,
  parseTonAsset,
  parseUnits,
  renderAsset,
  toTonconnect,
  withDeadline,
  withOmniston,
} from "./omniston.js";

const EVM_CHAINS = ["ethereum", "arbitrum", "base", "bnb", "polygon", "avalanche"] as const;
type EvmChain = (typeof EVM_CHAINS)[number];

// A live order answers sub-second; the window only buys certainty on the
// not-found path, so keep it short — track calls hold a connection slot.
const TRACK_WAIT_MS = 3_000;
// Before disclosing a secret the order MUST be found — wait a little longer.
const DISCLOSE_PROBE_WAIT_MS = 6_000;
// Refuse disclosure this close (seconds) to the destination rollback opening.
const ROLLBACK_SAFETY_MARGIN_S = 60;

const READY_PHASES = new Set([
  "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION",
  "EXECUTION_PHASE_READY_FOR_PUBLIC_COMPLETION",
]);

/** Validate an EVM address and return it in EIP-55 checksummed form.
 * Mixed-case input must carry a correct checksum (that is the typo guard
 * EIP-55 exists for); all-lowercase/uppercase input is normalized. */
function checksumEvmAddress(raw: string, what: string): string {
  const s = raw.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(s)) {
    throw new Error(`${what} must be a 0x… address (40 hex characters)`);
  }
  const body = s.slice(2);
  const lower = body.toLowerCase();
  const hash = keccak_256(Buffer.from(lower, "ascii"));
  let checksummed = "0x";
  for (let i = 0; i < 40; i++) {
    const nibble = (hash[i >> 1]! >> (i % 2 === 0 ? 4 : 0)) & 0xf;
    checksummed += nibble >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  }
  const isPlain = body === lower || body === body.toUpperCase();
  if (!isPlain && s !== checksummed) {
    throw new Error(
      `${what} fails its EIP-55 checksum — at least one character is wrong, re-copy the address`
    );
  }
  return checksummed;
}

type EvmAsset = { chain: { $case: EvmChain; value: { kind: { $case: "native"; value: {} } | { $case: "erc20"; value: string } } } };

function parseEvmAsset(chain: EvmChain, raw: string): EvmAsset {
  if (/^native$/i.test(raw.trim())) {
    return { chain: { $case: chain, value: { kind: { $case: "native", value: {} } } } };
  }
  const addr = checksumEvmAddress(raw, `to_asset (or use "native") on ${chain}`);
  return { chain: { $case: chain, value: { kind: { $case: "erc20", value: addr } } } };
}

function normalizeHashing(fn: string | undefined): "keccak256" | "sha256" | null {
  if (fn === "HASHING_FUNCTION_KECCAK256") return "keccak256";
  if (fn === "HASHING_FUNCTION_SHA256") return "sha256";
  return null;
}

/** "EXECUTION_PHASE_READY_FOR_PUBLIC_COMPLETION" → "ready_for_public_completion" */
function normalizePhase(phase: string | undefined): string | null {
  if (!phase) return null;
  return phase.replace(/^EXECUTION_PHASE_/, "").toLowerCase();
}

function normalizeStatus(status: string): string {
  return status.replace(/^TRADE_STATUS_/, "").toLowerCase();
}

function renderChainAddress(addr: { chain?: { $case: string; value: unknown } } | undefined): string | null {
  if (!addr?.chain) return null;
  return `${addr.chain.$case}:${String(addr.chain.value)}`;
}

type PhaseTimestamps = {
  privateCompletionAvailableTimestamp?: number | undefined;
  publicCompletionAvailableTimestamp?: number | undefined;
  privateRollbackAvailableTimestamp: number;
  publicRollbackAvailableTimestamp?: number | undefined;
};

/** HTLC windows (unix seconds) — an agent must never disclose close to the
 * destination position's rollback opening. */
function renderTimestamps(t: PhaseTimestamps | undefined): {
  private_completion_at: number | null;
  public_completion_at: number | null;
  private_rollback_at: number | null;
  public_rollback_at: number | null;
} | null {
  if (!t) return null;
  return {
    private_completion_at: t.privateCompletionAvailableTimestamp ?? null,
    public_completion_at: t.publicCompletionAvailableTimestamp ?? null,
    private_rollback_at: t.privateRollbackAvailableTimestamp ?? null,
    public_rollback_at: t.publicRollbackAvailableTimestamp ?? null,
  };
}

/** First order snapshot for a quote, or null if it never lands in the window. */
function fetchOrder(omni: Omniston, quoteId: string, traderAddress: string, waitMs: number): Promise<Order | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.unsubscribe();
      resolve(null);
    }, waitMs);
    const sub = omni
      .orderTrack({
        quoteId,
        traderAddress: { chain: { $case: "ton", value: traderAddress } },
      })
      .subscribe({
        next: (event) => {
          if (!("$case" in event) || event.$case !== "order") return;
          clearTimeout(timer);
          sub.unsubscribe();
          resolve(event.value);
        },
        error: (err) => {
          clearTimeout(timer);
          reject(describeError(err));
        },
        complete: () => {
          clearTimeout(timer);
          resolve(null);
        },
      });
  });
}

const quoteIdArg = z.string().describe("Quote id returned by get_crosschain_quote");

const tonconnectOutput = {
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
};

export function registerCrosschainTools(server: McpServer): void {
  server.registerTool(
    "get_crosschain_quote",
    {
      title: "Cross-chain swap quote",
      description:
        "Firm quote for swapping GRAM or a TON jetton into an asset on another blockchain (Ethereum, Arbitrum, Base, BNB, Polygon, Avalanche) " +
        "via Omniston's atomic HTLC escrow settlement. MAINNET only. TON is always the source chain — the trade is initiated and funded by a TON wallet. " +
        "Use when: an agent needs USDT/USDC/native coins delivered to an EVM address, paid from TON. Step 2 is build_crosschain_swap_tx with the returned quote_id. " +
        "Amounts are raw indivisible units of each asset (TON USDT = 6 decimals, GRAM = 9, EVM tokens per their own decimals). " +
        "Returns: quote_id (use PROMPTLY — quotes expire in about a minute), input/output amounts, fees, gas_budget_nano (GRAM needed for gas on TON), " +
        "security_deposit (extra value temporarily locked in the escrow, returned on completion), " +
        "htlc_hashing_function (COPY IT VERBATIM into build_crosschain_swap_tx) and estimated_settlement_seconds for the full cross-chain trade. " +
        "This is a price lookup only — nothing is signed or sent.",
      inputSchema: {
        from_asset: z
          .string()
          .describe('Asset to pay on TON: "GRAM" or a jetton master address (e.g. USDT "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")'),
        to_chain: z.enum(EVM_CHAINS).describe("Destination blockchain"),
        to_asset: z
          .string()
          .describe('Asset to receive: "native" (ETH/BNB/POL/AVAX) or a 0x… ERC-20 contract address on the destination chain'),
        amount_units: z
          .string()
          .describe('Amount in raw indivisible units of the "exact" side'),
        exact: z
          .enum(["input", "output"])
          .default("input")
          .describe("input = spend exactly this much of from_asset; output = target receiving this much of to_asset"),
      },
      outputSchema: {
        quote_id: z.string(),
        resolver: z.string(),
        input_asset: z.string(),
        output_asset: z.string(),
        input_units: z.string(),
        output_units: z.string(),
        protocol_fee_units: z.string(),
        integrator_fee_units: z.string(),
        gas_budget_nano: z.string().nullable(),
        security_deposit_asset: z.string().nullable(),
        security_deposit_units: z.string().nullable(),
        htlc_hashing_function: z.string().nullable(),
        estimated_settlement_seconds: z.number().nullable(),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ from_asset, to_chain, to_asset, amount_units, exact }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const inputAsset = parseTonAsset(from_asset);
        const outputAsset = parseEvmAsset(to_chain, to_asset);
        const units = parseUnits(amount_units, "amount_units");

        const quote = await withOmniston((omni) =>
          firstQuote(omni, {
            inputAsset,
            outputAsset,
            amount:
              exact === "output"
                ? { $case: "outputUnits", value: units }
                : { $case: "inputUnits", value: units },
            // no integratorParams() here: Omniston requires the integrator
            // address to live on the DESTINATION chain, and ours is a TON
            // wallet — attaching it gets the RFQ rejected outright
            settlementParams: [{ params: { $case: "order", value: {} } }],
          })
        );

        const order = quote.settlementData?.$case === "order" ? quote.settlementData.value : null;
        if (!order) throw new Error(`unexpected settlement type "${quote.settlementData?.$case}" — expected order (HTLC escrow)`);

        return ok({
          quote_id: quote.quoteId,
          resolver: quote.resolverName,
          input_asset: renderAsset(quote.inputAsset as never),
          output_asset: renderAsset(quote.outputAsset as never),
          input_units: quote.inputUnits,
          output_units: quote.outputUnits,
          protocol_fee_units: quote.protocolFeeUnits,
          integrator_fee_units: quote.integratorFeeUnits,
          gas_budget_nano: quote.gasBudget ?? null,
          security_deposit_asset: order.srcHtlcSecurityDepositAsset
            ? renderAsset(order.srcHtlcSecurityDepositAsset as never)
            : null,
          security_deposit_units: order.srcHtlcSecurityDepositUnits ?? null,
          htlc_hashing_function: normalizeHashing(order.htlcHashingFunction),
          estimated_settlement_seconds: quote.estimatedSettlementDuration ?? null,
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "build_crosschain_swap_tx",
    {
      title: "Build cross-chain swap transaction",
      description:
        "Build the UNSIGNED TON escrow transaction for a cross-chain swap quoted by get_crosschain_quote, and generate the HTLC secret that later completes it. " +
        "Non-custodial: nothing is signed or sent, and the server does NOT keep the secret — it exists only in this response. " +
        "The messages MOVE REAL FUNDS once signed; treat the output as an armed payment. " +
        "Treat htlc_secret like a payment authorization: anyone who sees it together with quote_id can trigger disclosure — keep this response out of logs and shared contexts. " +
        "EVERY CALL GENERATES A NEW SECRET bound to THIS tonconnect payload — if you rebuild for the same quote, discard every earlier payload and secret; " +
        "signing an older payload after a rebuild locks funds under a hash whose secret you no longer track. " +
        "THE FLOW AFTER THIS CALL: (1) the wallet owner signs and sends result.tonconnect; " +
        "(2) poll track_crosschain_swap every ~10s; (3) when an execution's dst_phase reaches ready_for_private_completion, " +
        "call disclose_crosschain_secret PROMPTLY with htlc_secret (the tool re-verifies the on-chain state before revealing anything); " +
        "(4) if nothing fills and cancellation_mode becomes onchain, reclaim funds with build_crosschain_refund. " +
        "STORE htlc_secret UNTIL THE TRADE COMPLETES — without it the trade cannot settle (funds remain refundable after the timeout, but the swap is lost).",
      inputSchema: {
        quote_id: quoteIdArg,
        wallet: z.string().describe("TON address that signs the escrow transfer, owns the position and receives refunds/gas excess"),
        to_chain: z.enum(EVM_CHAINS).describe("Destination blockchain (must match the quote)"),
        destination_address: z.string().describe("0x… wallet on the destination chain that receives the swap output"),
        hashing_function: z
          .enum(["keccak256", "sha256"])
          .describe(
            "REQUIRED: copy htlc_hashing_function from the quote VERBATIM. A mismatched hash builds an escrow that can never settle. " +
              "If the quote returned null here, do not proceed"
          ),
      },
      outputSchema: {
        quote_id: z.string(),
        wallet: z.string(),
        destination_address: z.string(),
        htlc_secret: z.string(),
        htlc_secret_hash: z.string(),
        ...tonconnectOutput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id, wallet, to_chain, destination_address, hashing_function }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const addr = parseAddress(wallet);
        const dst = checksumEvmAddress(destination_address, "destination_address");
        const id = quote_id.trim();
        if (!/^[0-9a-f]{64}$/i.test(id)) {
          throw new Error("quote_id must be the 64-char hex id returned by get_crosschain_quote");
        }

        const secret = randomBytes(32);
        const hash = hashing_function === "sha256" ? sha256(secret) : keccak_256(secret);

        const tx = await withOmniston((omni) =>
          withDeadline(
            omni.tonBuildEscrowTransfer({
              quoteId: id,
              ownerSrcAddress: { chain: { $case: "ton", value: addr.toString() } },
              traderDstAddress: { chain: { $case: to_chain, value: dst } },
              htlcSecrets: { secretMode: { $case: "provided", value: { hashes: [hash] } } },
            }),
            BUILD_TIMEOUT_MS,
            "building the escrow transaction"
          )
        );

        if (!tx.messages.length) throw new Error("Omniston returned no messages for this quote");

        return ok({
          quote_id: id,
          wallet: addr.toString({ bounceable: false }),
          destination_address: dst,
          htlc_secret: Buffer.from(secret).toString("hex"),
          htlc_secret_hash: Buffer.from(hash).toString("hex"),
          message_count: tx.messages.length,
          ...toTonconnect(tx.messages),
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "track_crosschain_swap",
    {
      title: "Track cross-chain swap",
      description:
        "Current status of a cross-chain swap: the escrow order created from a get_crosschain_quote quote, with per-execution lifecycle phases and HTLC time windows on both chains. " +
        "Use when: after sending the escrow transaction built by build_crosschain_swap_tx — poll every ~10s. " +
        "Reading the result: found=false means the escrow transaction has not landed yet (or was never sent); " +
        "when an execution's dst_phase reaches ready_for_private_completion, call disclose_crosschain_secret promptly — " +
        "do NOT disclose if now is close to that execution's output_position_timestamps.private_rollback_at (unix seconds): past it the resolver can roll the destination back, " +
        "and a late reveal risks losing the input without receiving the output. " +
        "status becomes fully_filled once settled; cancellation_mode=onchain means funds can be reclaimed with build_crosschain_refund. " +
        "Returns a snapshot, not a stream — poll again for updates.",
      inputSchema: {
        quote_id: quoteIdArg,
        wallet: z.string().describe("The TON wallet that sent the escrow transaction"),
      },
      outputSchema: {
        found: z.boolean(),
        status: z.string().nullable(),
        remaining_input_units: z.string().nullable(),
        escrowed_input_units: z.string().nullable(),
        cancellation_mode: z.string().nullable(),
        estimated_finish_timestamp: z.number().nullable(),
        maximum_finish_timestamp: z.number().nullable(),
        executions: z.array(
          z.object({
            index: z.number(),
            resolver: z.string(),
            input_units: z.string(),
            output_units: z.string(),
            src_phase: z.string().nullable(),
            dst_phase: z.string().nullable(),
            input_position: z.string().nullable(),
            output_position: z.string().nullable(),
            input_position_timestamps: z
              .object({
                private_completion_at: z.number().nullable(),
                public_completion_at: z.number().nullable(),
                private_rollback_at: z.number().nullable(),
                public_rollback_at: z.number().nullable(),
              })
              .nullable(),
            output_position_timestamps: z
              .object({
                private_completion_at: z.number().nullable(),
                public_completion_at: z.number().nullable(),
                private_rollback_at: z.number().nullable(),
                public_rollback_at: z.number().nullable(),
              })
              .nullable(),
          })
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id, wallet }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const addr = parseAddress(wallet);
        const id = quote_id.trim();
        if (!/^[0-9a-f]{64}$/i.test(id)) {
          throw new Error("quote_id must be the 64-char hex id returned by get_crosschain_quote");
        }

        const order = await withOmniston(
          (omni) => fetchOrder(omni, id, addr.toString(), TRACK_WAIT_MS),
          "track"
        );

        if (!order) {
          return ok({
            found: false,
            status: null,
            remaining_input_units: null,
            escrowed_input_units: null,
            cancellation_mode: null,
            estimated_finish_timestamp: null,
            maximum_finish_timestamp: null,
            executions: [],
          });
        }

        return ok({
          found: true,
          status: normalizeStatus(order.status),
          remaining_input_units: order.remainingInputUnits,
          escrowed_input_units: order.escrowedInputUnits,
          cancellation_mode: order.cancellationMode
            .replace(/^ORDER_CANCELLATION_MODE_/, "")
            .toLowerCase(),
          estimated_finish_timestamp: order.estimatedFinishTimestamp ?? null,
          maximum_finish_timestamp: order.maximumFinishTimestamp ?? null,
          executions: order.executions.map((e) => ({
            index: e.index,
            resolver: e.resolverName,
            input_units: e.inputUnits,
            output_units: e.outputUnits,
            src_phase: normalizePhase(e.inputPositionPhase),
            dst_phase: normalizePhase(e.outputPositionPhase),
            input_position: renderChainAddress(e.inputPositionAddress as never),
            output_position: renderChainAddress(e.outputPositionAddress as never),
            input_position_timestamps: renderTimestamps(e.inputPositionPhaseTimestamps),
            output_position_timestamps: renderTimestamps(e.outputPositionPhaseTimestamps),
          })),
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "disclose_crosschain_secret",
    {
      title: "Disclose HTLC secret",
      description:
        "Reveal the HTLC secret from build_crosschain_swap_tx to settle a cross-chain swap. This is the final, trade-committing step: " +
        "once revealed the preimage is public and the resolver can claim the TON side — it CANNOT be taken back. " +
        "Before revealing anything, the tool re-verifies live state and refuses unless ALL of these hold: the order exists on-chain, " +
        "the destination position is at ready_for_private_completion or ready_for_public_completion, and the secret matches that execution's on-chain hash. " +
        "Call it as soon as track_crosschain_swap shows dst_phase=ready_for_private_completion — a prompt reveal keeps a wide safety margin " +
        "before the destination's rollback window opens. " +
        "The secret can only complete the trade as quoted; it cannot redirect funds.",
      inputSchema: {
        quote_id: quoteIdArg,
        wallet: z.string().describe("The TON wallet that created the escrow position (used to locate and verify the order)"),
        secret: z.string().describe("htlc_secret (64-char hex) returned by build_crosschain_swap_tx"),
        execution_index: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe("Execution index from track_crosschain_swap (0 for single-fill trades — the default)"),
      },
      outputSchema: {
        disclosed: z.boolean(),
        quote_id: z.string(),
        execution_index: z.number(),
        verified_dst_phase: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id, wallet, secret, execution_index }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const addr = parseAddress(wallet);
        const id = quote_id.trim();
        if (!/^[0-9a-f]{64}$/i.test(id)) {
          throw new Error("quote_id must be the 64-char hex id returned by get_crosschain_quote");
        }
        const secretHex = secret.trim();
        if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
          throw new Error("secret must be the 64-char hex htlc_secret returned by build_crosschain_swap_tx");
        }
        const secretBytes = Buffer.from(secretHex, "hex");

        const phase = await withOmniston(async (omni) => {
          // pre-flight on the same connection: the preimage is revealed only
          // against a live, ready, hash-matching destination position
          const order = await fetchOrder(omni, id, addr.toString(), DISCLOSE_PROBE_WAIT_MS);
          if (!order) {
            throw new Error(
              "order not found — the escrow transaction has not landed (or quote_id/wallet is wrong); secret NOT disclosed"
            );
          }
          const exec = order.executions.find((e) => e.index === execution_index);
          if (!exec) {
            throw new Error(
              `execution ${execution_index} not found on this order (${order.executions.length} execution(s)); secret NOT disclosed`
            );
          }
          const dstPhase = exec.outputPositionPhase;
          if (!dstPhase || !READY_PHASES.has(dstPhase)) {
            throw new Error(
              `destination position is not ready (dst_phase=${normalizePhase(dstPhase) ?? "missing"}) — ` +
                "disclosing now would let the resolver claim your TON without delivering; keep polling track_crosschain_swap; secret NOT disclosed"
            );
          }
          if (exec.secretHash && exec.secretHash.length > 0) {
            const expected = Buffer.from(exec.secretHash);
            const kec = Buffer.from(keccak_256(secretBytes));
            const sha = Buffer.from(sha256(secretBytes));
            if (!expected.equals(kec) && !expected.equals(sha)) {
              throw new Error(
                "secret does not match this execution's on-chain hash — wrong secret or wrong quote_id pair; secret NOT disclosed"
              );
            }
          }
          // Refuse to disclose within a safety margin of the destination
          // position's rollback opening: past it the resolver could roll the
          // destination back and still claim the TON side with the now-public
          // preimage — the classic late-reveal loss. Refund instead. (Checked
          // last, after the secret is validated, so a mistyped secret gets the
          // precise error rather than this one.)
          const rollbackAt = exec.outputPositionPhaseTimestamps?.privateRollbackAvailableTimestamp;
          if (rollbackAt && Date.now() / 1000 + ROLLBACK_SAFETY_MARGIN_S > rollbackAt) {
            throw new Error(
              "too close to the destination rollback window — a late reveal risks losing the input; " +
                "do NOT disclose, reclaim the escrow with build_crosschain_refund instead; secret NOT disclosed"
            );
          }
          await withDeadline(
            omni.orderDiscloseHtlcSecret({
              quoteId: id,
              executionIndex: execution_index,
              secret: secretBytes,
            }),
            BUILD_TIMEOUT_MS,
            "disclosing the HTLC secret"
          );
          return normalizePhase(dstPhase);
        });

        return ok({
          disclosed: true,
          quote_id: id,
          execution_index,
          verified_dst_phase: phase ?? "unknown",
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "build_crosschain_refund",
    {
      title: "Build cross-chain refund",
      description:
        "Build the UNSIGNED transaction that cancels a cross-chain escrow position and returns the funds to the owner wallet. " +
        "Use when: a cross-chain swap did not settle — track_crosschain_swap shows cancellation_mode=onchain (before that the position cannot be cancelled by the trader). " +
        "Non-custodial: returns TonConnect-ready messages for the SAME wallet that created the escrow; nothing is signed or sent here. " +
        "After signing and sending, the escrowed input (and the security deposit) come back to the owner.",
      inputSchema: {
        quote_id: quoteIdArg,
        wallet: z.string().describe("The TON wallet that created the escrow position (only it can cancel)"),
      },
      outputSchema: {
        quote_id: z.string(),
        wallet: z.string(),
        ...tonconnectOutput,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id, wallet }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const addr = parseAddress(wallet);
        const id = quote_id.trim();
        if (!/^[0-9a-f]{64}$/i.test(id)) {
          throw new Error("quote_id must be the 64-char hex id returned by get_crosschain_quote");
        }

        const tx = await withOmniston((omni) =>
          withDeadline(
            omni.tonBuildEscrowCancellation({
              quoteId: id,
              ownerAddress: { chain: { $case: "ton", value: addr.toString() } },
            }),
            BUILD_TIMEOUT_MS,
            "building the refund transaction"
          )
        );

        if (!tx.messages.length) throw new Error("Omniston returned no messages for this refund");

        return ok({
          quote_id: id,
          wallet: addr.toString({ bounceable: false }),
          message_count: tx.messages.length,
          ...toTonconnect(tx.messages),
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );
}
