// Shared Omniston plumbing for the swap tools (intrachain + cross-chain).
//
// Omniston is STON.fi's RFQ protocol over WebSocket (wss://omni-ws.ston.fi,
// no API key). Every tool call opens a dedicated one-shot connection and
// tears it down before returning; quotes are stored Omniston-side by id.

import { Omniston, WebSocketTransport, type Quote } from "@ston-fi/omniston-sdk";
import { parseAddress } from "./server.js";

export const OMNISTON_URL = process.env.OMNISTON_API_URL ?? "wss://omni-ws.ston.fi";

// Omniston has no public testnet endpoint — a --testnet server quoting real
// mainnet swaps would be a trap. Explicit OMNISTON_API_URL overrides the block.
export const TESTNET_BLOCKED =
  (process.env.TON_NETWORK === "testnet" || process.argv.includes("--testnet")) &&
  !process.env.OMNISTON_API_URL;

export const TESTNET_ERROR =
  "swap tools are mainnet-only (Omniston has no public testnet endpoint) — run without --testnet / TON_NETWORK=testnet";

export const QUOTE_WAIT_MS = 25_000;
export const BUILD_TIMEOUT_MS = 15_000;
/** TonConnect chain id for TON mainnet — lets compliant wallets refuse to sign on the wrong network. */
export const TONCONNECT_MAINNET = "-239";

// One socket per call is fine; hundreds at once from a single hosted IP is
// not. Excess callers fail fast instead of queueing into Omniston. Tracking
// polls get their own pool so a dutifully-polling agent cannot starve
// quote/build calls for every other tenant of a hosted server.
const POOLS = {
  main: { max: 8, active: 0 },
  track: { max: 8, active: 0 },
};
export type PoolName = keyof typeof POOLS;

/** Optional revenue share: fee (in bps of the output) paid to this address.
 * Both env vars must be valid or the fee is off — loudly, not silently. */
export const INTEGRATOR = ((): { address: string; feePips: number } | null => {
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

/** RFQ fields adding the operator's fee, when configured. */
export function integratorParams() {
  return INTEGRATOR
    ? {
        integratorAddress: { chain: { $case: "ton" as const, value: INTEGRATOR.address } },
        integratorFeePips: INTEGRATOR.feePips,
      }
    : {};
}

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

/** Run fn with a dedicated one-shot Omniston connection that always gets torn down.
 * No AutoReconnectTransport: a per-call connection has nothing to resume, and
 * dropping it removes the SDK's floating re-subscribe promise (an
 * unhandledRejection vector) while making dial failures reject immediately. */
export async function withOmniston<T>(fn: (omni: Omniston) => Promise<T>, pool: PoolName = "main"): Promise<T> {
  const p = POOLS[pool];
  if (p.active >= p.max) {
    throw new Error("swap service is busy (too many concurrent quote/build calls) — retry in a few seconds");
  }
  p.active++;
  const omni = new Omniston({ apiUrl: OMNISTON_URL, transport: new SafeWebSocketTransport(OMNISTON_URL) });
  try {
    return await fn(omni);
  } finally {
    p.active--;
    try {
      omni.transport.close();
    } catch {
      // best-effort teardown — the result (or the real error) is already decided
    }
  }
}

export function withDeadline<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export function describeError(err: unknown): Error {
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

/** Subscribe to the RFQ stream and resolve on the first firm quote. */
export function firstQuote(omni: Omniston, request: Parameters<Omniston["requestForQuote"]>[0]): Promise<Quote> {
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

export type TonAsset = { chain: { $case: "ton"; value: { kind: { $case: "native"; value: {} } | { $case: "jetton"; value: string } } } };

/** "GRAM" / "TON" / "native" → the native coin; anything else must be a jetton master address. */
export function parseTonAsset(raw: string): TonAsset {
  const s = raw.trim();
  if (/^(gram|ton|toncoin|native)$/i.test(s)) {
    return { chain: { $case: "ton", value: { kind: { $case: "native", value: {} } } } };
  }
  const addr = parseAddress(s);
  return { chain: { $case: "ton", value: { kind: { $case: "jetton", value: addr.toString() } } } };
}

/** Human-readable echo of an AssetId on any chain: "GRAM", a jetton address, or "chain:0x…". */
export function renderAsset(asset: { chain?: { $case: string; value?: { kind?: { $case: string; value?: unknown } } } } | undefined): string {
  const chain = asset?.chain;
  const kind = chain?.value?.kind;
  if (!chain || !kind) return "?";
  if (chain.$case === "ton") return kind.$case === "native" ? "GRAM" : String(kind.value);
  return `${chain.$case}:${kind.$case === "native" ? "native" : String(kind.value)}`;
}

export function parseUnits(raw: string, field: string): string {
  let v: bigint;
  try {
    v = BigInt(raw.trim());
  } catch {
    throw new Error(`${field} must be an integer amount in raw indivisible units, e.g. "1000000000"`);
  }
  if (v <= 0n) throw new Error(`${field} must be positive`);
  return v.toString();
}

/** Convert Omniston's hex-encoded messages into the exact TonConnect sendTransaction shape. */
export function toTonconnect(messages: Array<{ targetAddress: string; sendAmount: string; payload: string; jettonWalletStateInit?: string | undefined }>) {
  const converted = messages.map((m) => ({
    address: m.targetAddress,
    amount: m.sendAmount,
    payload: Buffer.from(m.payload, "hex").toString("base64"),
    ...(m.jettonWalletStateInit
      ? { stateInit: Buffer.from(m.jettonWalletStateInit, "hex").toString("base64") }
      : {}),
  }));
  const total = messages.reduce((sum, m) => sum + BigInt(m.sendAmount), 0n);
  return {
    total_attached_nano: total.toString(),
    tonconnect: {
      validUntil: Math.floor(Date.now() / 1000) + 300,
      network: TONCONNECT_MAINNET,
      messages: converted,
    },
  };
}
