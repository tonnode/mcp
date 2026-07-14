import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine } from "ton-lite-client";

const MAINNET_CONFIG = "https://ton.org/global.config.json";
const TESTNET_CONFIG = "https://ton.org/testnet-global.config.json";

type LiteserverEntry = {
  ip: number | string;
  port: number;
  id: { key: string };
};

/** The global config stores IPs as signed 32-bit integers. */
function intToIp(ip: number | string): string {
  if (typeof ip === "string") return ip;
  const u = ip < 0 ? ip + 2 ** 32 : ip;
  return [(u >>> 24) & 0xff, (u >>> 16) & 0xff, (u >>> 8) & 0xff, u & 0xff].join(".");
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function resolveServers(): Promise<LiteserverEntry[]> {
  // Highest priority: explicit liteservers (point this at your own node).
  // Format: [{"ip":"1.2.3.4","port":40004,"key":"<base64 ed25519>"}]
  const own = process.env.TON_LITESERVERS;
  if (own) {
    const parsed = JSON.parse(own) as Array<{ ip: number | string; port: number; key: string }>;
    return parsed.map((s) => ({ ip: s.ip, port: s.port, id: { key: s.key } }));
  }

  const testnet =
    process.env.TON_NETWORK === "testnet" || process.argv.includes("--testnet");
  const url =
    process.env.TON_CONFIG_URL ?? (testnet ? TESTNET_CONFIG : MAINNET_CONFIG);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch TON config from ${url}: ${res.status}`);
  const config = (await res.json()) as { liteservers: LiteserverEntry[] };
  if (!config.liteservers?.length) throw new Error(`No liteservers in config at ${url}`);
  return config.liteservers;
}

let clientPromise: Promise<LiteClient> | null = null;

export function getClient(): Promise<LiteClient> {
  clientPromise ??= (async () => {
    const servers = shuffle(await resolveServers()).slice(0, 8);
    const engines = servers.map(
      (s) =>
        new LiteSingleEngine({
          host: `tcp://${intToIp(s.ip)}:${s.port}`,
          publicKey: Buffer.from(s.id.key, "base64"),
        })
    );
    return new LiteClient({ engine: new LiteRoundRobinEngine(engines) });
  })().catch((err) => {
    // don't cache a failed init (e.g. transient config-fetch error) forever
    clientPromise = null;
    throw err;
  });
  return clientPromise;
}

/** Runs a lite-client call with a hard timeout so a dead server can't hang a tool. */
export async function withTimeout<T>(work: Promise<T>, ms = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`liteserver query timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
