// Hosted mode: the same TON MCP server over Streamable HTTP.
//
//   PORT=8808 TONNODE_KEYS=tn_live_abc,tn_live_def npx -y @tonnode/mcp --http
//
// Clients connect with:
//   { "mcpServers": { "ton": { "url": "https://mcp.tonnode.io/mcp",
//                              "headers": { "Authorization": "Bearer tn_live_abc" } } } }
//
// Binds 127.0.0.1 by default — run behind a TLS reverse proxy (Caddy/nginx)
// and set HOST=0.0.0.0 only when the proxy lives on another machine.
// Refuses to start without TONNODE_KEYS unless TONNODE_ALLOW_OPEN=1 is set
// explicitly (open mode is for self-hosting behind your own firewall only).

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { readFileSync, watchFile } from "node:fs";
import { appendFile } from "node:fs/promises";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createTonServer } from "./server.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8808);
const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 300);
const GLOBAL_RATE_LIMIT_RPM = Number(process.env.GLOBAL_RATE_LIMIT_RPM ?? 0); // 0 = off
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MIN ?? 30) * 60_000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 500);
const MAX_SESSIONS_PER_KEY = Number(process.env.MAX_SESSIONS_PER_KEY ?? 50);

// ---------- API keys ----------
//
// Two sources:
//   TONNODE_KEYS       — comma-separated list, fixed for the process lifetime
//   TONNODE_KEYS_FILE  — JSON array of {"key", "label"?, "rpm"?, "expires"?}.
//                        Reloaded on change and on SIGHUP — add/revoke keys
//                        without restarting; sessions of revoked keys close.
//                        "expires" (ISO date) makes a key stop working on its
//                        own when a customer's plan runs out.

type KeyRecord = {
  rpm?: number;
  expires?: string;
  label?: string;
  /**
   * Optional source-address allowlist: plain IPv4/IPv6 addresses or CIDR
   * ranges. ABSENT means "any address", which is how every key issued before
   * this existed behaves — the restriction only ever engages when a customer
   * opts in from the dashboard, so adding this field cannot lock anyone out.
   */
  ips?: string[];
};

const KEYS_FILE = process.env.TONNODE_KEYS_FILE;
const KEYS = new Map<string, KeyRecord>();
let OPEN_MODE = false; // decided once at startup; a later-emptied keys file locks, never opens

function loadKeys(reason: string): void {
  let next: Map<string, KeyRecord>;
  if (KEYS_FILE) {
    try {
      const raw = JSON.parse(readFileSync(KEYS_FILE, "utf-8")) as Array<{ key: string } & KeyRecord>;
      if (!Array.isArray(raw)) throw new Error("keys file must be a JSON array");
      next = new Map(
        raw
          .filter((e) => typeof e?.key === "string" && e.key.length > 0)
          // `ips` was missing from this projection, so the allowlist below
          // could never fire for a key loaded from the file — which is every
          // key in production. The billing service validates the addresses,
          // writes them into the registry and the console shows the key as
          // restricted; the server then dropped the field on load and served
          // the key from anywhere. Every field the auth path reads has to
          // survive this map.
          .map((e) => [e.key, { rpm: e.rpm, expires: e.expires, label: e.label, ips: e.ips }])
      );
    } catch (err) {
      console.error(
        `tonnode-mcp: cannot load ${KEYS_FILE} (${err instanceof Error ? err.message : err}) — keeping previous key set`
      );
      return;
    }
  } else {
    next = new Map(
      (process.env.TONNODE_KEYS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .map((k) => [k, {}])
    );
  }
  KEYS.clear();
  for (const [k, v] of next) KEYS.set(k, v);
  // revoked keys lose their live sessions immediately
  for (const [id, s] of sessions) {
    if (s.key !== "open" && !KEYS.has(s.key)) {
      sessions.delete(id);
      s.transport.close().catch(() => {});
    }
  }
  console.error(`tonnode-mcp: ${KEYS.size} API key(s) active (${reason})`);
}

// ---------- token buckets (per key + optional global backend guard) ----------

const buckets = new Map<string, { tokens: number; stamp: number }>();

function allow(id: string, rpm: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(id) ?? { tokens: rpm, stamp: now };
  bucket.tokens = Math.min(rpm, bucket.tokens + ((now - bucket.stamp) / 60_000) * rpm);
  bucket.stamp = now;
  if (bucket.tokens < 1) {
    buckets.set(id, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(id, bucket);
  return true;
}

/**
 * The caller's address as seen past the TLS proxy.
 *
 * Caddy sets X-Forwarded-For and we bind 127.0.0.1, so the only writer of that
 * header is our own proxy — a client-supplied value cannot reach us. The first
 * entry is the original client.
 */
function clientIp(req: IncomingMessage): string {
  // The LAST entry, not the first.
  //
  // This address decides whether a key with an allowlist is accepted, so the
  // question is which part of the header an attacker controls. Caddy as
  // configured today REPLACES X-Forwarded-For with the real peer, so there is
  // exactly one entry and either end works — verified by proxying a spoofed
  // header through it.
  //
  // But that safety comes from the proxy, not from here. Put any appending
  // proxy in front and the header becomes "<whatever the client typed>, <real
  // client>": the first entry is then attacker-controlled and the allowlist
  // is bypassed by sending one header. The last entry is always the one our
  // own nearest proxy wrote. If that ever stops matching a customer's rule the
  // failure is a refused request, not a granted one.
  const fwd = req.headers["x-forwarded-for"];
  const raw = Array.isArray(fwd) ? fwd[fwd.length - 1] : fwd;
  const parts = (raw ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const nearest = parts.length > 0 ? parts[parts.length - 1] : "";
  const addr = nearest || req.socket.remoteAddress || "";
  // ::ffff:1.2.3.4 → 1.2.3.4
  return addr.startsWith("::ffff:") ? addr.slice(7) : addr;
}

function ipToBig(ip: string): bigint | null {
  if (ip.includes(":")) {
    // IPv6, possibly with a :: run.
    const [head, tail] = ip.split("::");
    const h = head ? head.split(":") : [];
    const t = tail ? tail.split(":") : [];
    if (h.length + t.length > 8) return null;
    const parts = ip.includes("::")
      ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t]
      : ip.split(":");
    if (parts.length !== 8) return null;
    let out = 0n;
    for (const part of parts) {
      if (!/^[0-9a-f]{0,4}$/i.test(part)) return null;
      out = (out << 16n) | BigInt(parseInt(part || "0", 16));
    }
    return out;
  }
  const octets = ip.split(".");
  if (octets.length !== 4) return null;
  let out = 0n;
  for (const octet of octets) {
    const n = Number(octet);
    if (!/^\d{1,3}$/.test(octet) || n > 255) return null;
    out = (out << 8n) | BigInt(n);
  }
  return out;
}

/** True when `ip` falls inside `rule`, which is an address or a CIDR block. */
function ipMatches(ip: string, rule: string): boolean {
  const [network, bitsRaw] = rule.split("/");
  const a = ipToBig(ip);
  const b = ipToBig(network);
  if (a === null || b === null) return false;
  if (bitsRaw === undefined) return a === b;

  const width = network.includes(":") ? 128 : 32;
  const bits = Number(bitsRaw);
  if (!Number.isInteger(bits) || bits < 0 || bits > width) return false;
  if (ip.includes(":") !== network.includes(":")) return false;
  const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(width - bits);
  return (a & mask) === (b & mask);
}

function authenticate(req: IncomingMessage): string | null {
  if (OPEN_MODE) return "open";
  if (KEYS.size === 0) return null; // keys file emptied at runtime → locked, not open
  // accept "Authorization: Bearer <key>", a bare "Authorization: <key>",
  // and "X-API-Key: <key>" — gateways like Smithery reserve the
  // Authorization header for themselves and pass keys via custom headers
  const apiKeyHeader = req.headers["x-api-key"];
  const raw = (
    req.headers.authorization ??
    (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader) ??
    ""
  ).trim();
  if (!raw) return null;
  const key = raw.replace(/^Bearer\s+/i, "").trim();
  const rec = KEYS.get(key);
  if (!rec) return null;
  if (rec.expires && Date.parse(rec.expires) < Date.now()) return null;
  if (rec.ips && rec.ips.length > 0) {
    const ip = clientIp(req);
    if (!ip || !rec.ips.some((rule) => ipMatches(ip, rule))) {
      console.error(`auth: ${key.slice(0, 11)}… rejected from ${ip || "unknown"} (not in allowlist)`);
      return null;
    }
  }
  return key;
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
      ...headers,
    })
    .end(JSON.stringify(body));
}

/**
 * The challenge that turns a refusal into an instruction.
 *
 * A 401 carrying no `WWW-Authenticate` says "rejected" and nothing about how
 * to fix it. RFC 9110 requires the header on every 401 and RFC 6750 defines
 * this exact shape for bearer tokens, so a client that probes the endpoint
 * before connecting learns the scheme instead of giving up. Smithery recorded
 * 197 sessions and zero tool calls against this server — which is what that
 * failure looks like from the outside.
 *
 * Deliberately NOT advertising `resource_metadata`: that field points at an
 * OAuth protected-resource document, and this server has no authorization
 * server to describe. Keys are issued to a human in the console. Pointing an
 * OAuth-capable client at a discovery document that cannot exist would replace
 * a silent failure with a confusing one. The static server card already
 * publishes `authentication: { schemes: ["bearer"] }` alongside every tool.
 *
 * `error` and `error_description` distinguish "you sent nothing" from "you
 * sent something we rejected" — the difference between a config the user has
 * not filled in and a key that expired.
 */
function authChallenge(sent: boolean): Record<string, string> {
  const error = sent
    ? `, error="invalid_token", error_description="The API key is unknown or expired. Issue a new one at https://tonnode.io/dashboard"`
    : `, error_description="Send your API key as: Authorization: Bearer <key>. Get one at https://tonnode.io/dashboard"`;
  return { "WWW-Authenticate": `Bearer realm="TONNode MCP"${error}` };
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) throw new HttpError(413, "body too large (max 1 MB)");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, "request body is not valid JSON");
  }
}

// ---------- session registry ----------

type Session = {
  transport: StreamableHTTPServerTransport;
  key: string;
  lastSeen: number;
};

const sessions = new Map<string, Session>();

function sessionsOf(key: string): number {
  let n = 0;
  for (const s of sessions.values()) if (s.key === key) n++;
  return n;
}

async function newSession(key: string): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, key, lastSeen: Date.now() });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  await createTonServer().connect(transport);
  return transport;
}

// Real MCP clients rarely send DELETE — they drop the connection and
// re-initialize later. Sweep idle sessions so the registry can't grow forever.
setInterval(() => {
  const cutoff = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) {
      sessions.delete(id);
      s.transport.close().catch(() => {});
    }
  }
}, 60_000).unref();

// ---------- per-call usage log (opt-in: TONNODE_USAGE_LOG=<path>) ----------
//
// One JSON line per HTTP request to /mcp, written after the response has
// finished; the tonnode-admin panel ingests the file. A line carries the
// registry label and a short hint of the key, never the key itself.
// Writes are chained (ordered, off the request path) and appendFile reopens
// the path every time, so the reader may rename or truncate the file at will.
// Every failure is swallowed: logging must never change a response.

const USAGE_LOG = process.env.TONNODE_USAGE_LOG || undefined;
let usageChain: Promise<void> = Promise.resolve();
let usageErrorAt = 0;

function usageError(err: unknown): void {
  const now = Date.now();
  if (now - usageErrorAt < 60_000) return; // at most one console line per minute
  usageErrorAt = now;
  console.error(
    `${new Date(now).toISOString()} usage log: ${err instanceof Error ? err.message : String(err)} (muted for 1 min)`
  );
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

/** "tn_live_abc…wxyz"; null for anything shorter than 20 chars, where a hint would be most of the key. */
function keyHint(key: string): string | null {
  return key.length >= 20 ? `${key.slice(0, 11)}…${key.slice(-4)}` : null;
}

/** The key the client offered, read from the same headers authenticate() reads. */
function offeredKey(req: IncomingMessage): string {
  const apiKeyHeader = req.headers["x-api-key"];
  const raw = (req.headers.authorization ?? (Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader) ?? "").trim();
  return raw.replace(/^Bearer\s+/i, "").trim();
}

/**
 * Arms the usage line for one /mcp request. `key` is authenticate()'s result
 * (null = refused). The POST branch puts the parsed body into the returned
 * holder; the line itself is built and queued only on "finish".
 *
 * Everything read from `req` is read here, not on "finish": by then Node may
 * have detached the socket (e.g. after a 413), and clientIp() would throw.
 * Every string the client controls is clipped, so one request cannot write
 * a line of up to the 1 MB body limit.
 */
function trackUsage(req: IncomingMessage, res: ServerResponse, key: string | null): { body?: unknown } {
  const call: { body?: unknown } = {};
  try {
    armUsageLine(req, res, key, call);
  } catch (err) {
    usageError(err);
  }
  return call;
}

function armUsageLine(req: IncomingMessage, res: ServerResponse, key: string | null, call: { body?: unknown }): void {
  const started = Date.now();
  const label = key !== null && key !== "open" ? KEYS.get(key)?.label ?? null : null;
  const http = req.method ?? null;
  const hint = key === "open" ? null : keyHint(key ?? offeredKey(req));
  const sidHeader = req.headers["mcp-session-id"];
  const sid = typeof sidHeader === "string" && sidHeader ? sidHeader.slice(0, 8) : null;
  const ipRaw = clientIp(req);
  const ip = ipRaw ? clip(ipRaw, 64) : null;
  const uaHeader = req.headers["user-agent"];
  const ua = typeof uaHeader === "string" && uaHeader ? clip(uaHeader, 120) : null;
  res.on("finish", () => {
    try {
      const body = call.body;
      const msg = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
      const params =
        msg?.params && typeof msg.params === "object" ? (msg.params as Record<string, unknown>) : null;
      const rpc = typeof msg?.method === "string" ? clip(msg.method, 100) : null;
      const id = typeof msg?.id === "string" ? clip(msg.id, 100) : typeof msg?.id === "number" ? msg.id : null;
      const line = JSON.stringify({
        ts: new Date(started).toISOString(),
        ms: Date.now() - started,
        http,
        status: res.statusCode,
        rpc,
        id,
        tool: rpc === "tools/call" && typeof params?.name === "string" ? clip(params.name, 100) : null,
        args: params && params.arguments !== undefined ? clip(JSON.stringify(params.arguments), 400) : null,
        key_label: label,
        key_hint: hint,
        sid,
        ip,
        ua,
      });
      usageChain = usageChain.then(() => appendFile(USAGE_LOG!, line + "\n")).catch(usageError);
    } catch (err) {
      usageError(err);
    }
  });
}

// ---------- http server ----------

function logLine(req: IncomingMessage, res: ServerResponse, key: string | null, sid?: string) {
  const keyTag = key === null ? "-" : key === "open" ? "open" : key.slice(0, 11) + "…";
  console.error(
    `${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} key=${keyTag}${sid ? ` sid=${sid.slice(0, 8)}` : ""}`
  );
}

export function startHttp(): void {
  // One process serves every API key. A stray async error escaping a
  // dependency (e.g. an upstream WebSocket emitting outside any call's
  // try/catch) must be logged, not allowed to take down all sessions.
  process.on("unhandledRejection", (reason) => {
    const text = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    console.error(`${new Date().toISOString()} UNHANDLED REJECTION ${text}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`${new Date().toISOString()} UNCAUGHT EXCEPTION ${err.stack ?? err.message}`);
  });

  loadKeys("startup");

  // fail closed: a typo'd env var must not silently expose an open server
  if (KEYS.size === 0) {
    if (process.env.TONNODE_ALLOW_OPEN !== "1") {
      console.error(
        "tonnode-mcp: refusing to start --http without API keys. " +
          "Set TONNODE_KEYS / TONNODE_KEYS_FILE, or explicitly opt in to open access with TONNODE_ALLOW_OPEN=1."
      );
      process.exit(1);
    }
    OPEN_MODE = true;
  }

  // hot reload: edit the keys file (or send SIGHUP) — no restart, sessions survive
  if (KEYS_FILE) {
    watchFile(KEYS_FILE, { interval: 5_000 }, () => loadKeys("file change"));
    process.on("SIGHUP", () => loadKeys("SIGHUP"));
  }

  const httpServer = createHttpServer(async (req, res) => {
    let key: string | null = null;
    let sid: string | undefined;
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        return reply(res, 200, { ok: true, sessions: sessions.size });
      }

      if (url.pathname !== "/mcp") {
        return reply(res, 404, { error: "not found — MCP endpoint is POST /mcp" });
      }

      key = authenticate(req);
      const usage = USAGE_LOG ? trackUsage(req, res, key) : null;
      if (!key) {
        // Whether anything was offered at all decides which challenge the
        // client gets — see authChallenge.
        const offered = Boolean(req.headers.authorization || req.headers["x-api-key"]);
        return reply(
          res,
          401,
          {
            error: "invalid, missing or expired API key",
            hint: "Send it as: Authorization: Bearer <key>",
            docs: "https://tonnode.io/en/docs/mcp",
            get_a_key: "https://tonnode.io/dashboard",
          },
          authChallenge(offered)
        );
      }
      const rpm = KEYS.get(key)?.rpm ?? RATE_LIMIT_RPM;
      if (!allow(`key:${key}`, rpm)) {
        return reply(res, 429, { error: `rate limit exceeded (${rpm}/min for this key)` });
      }
      // global guard protects the backend liteserver regardless of how many keys exist
      if (GLOBAL_RATE_LIMIT_RPM > 0 && !allow("__global__", GLOBAL_RATE_LIMIT_RPM)) {
        return reply(res, 429, { error: "server is at capacity, retry shortly" });
      }

      sid = req.headers["mcp-session-id"] as string | undefined;
      const session = sid ? sessions.get(sid) : undefined;
      // Sessions are private to the key that opened them.
      if (session && session.key !== key) return reply(res, 404, { error: "unknown or expired session" });
      if (session) session.lastSeen = Date.now();

      if (req.method === "POST") {
        const body = await readBody(req);
        if (usage) usage.body = body;
        // one token from the rate bucket must buy one message, not a batch of
        // thousands; batching was removed from the MCP spec in 2025-06-18 anyway
        if (Array.isArray(body)) {
          return reply(res, 400, { error: "batch requests not supported" });
        }
        let transport = session?.transport;
        if (!transport) {
          if (sid) return reply(res, 404, { error: "unknown or expired session" });
          if (!isInitializeRequest(body)) {
            return reply(res, 400, { error: "no session — first request must be initialize" });
          }
          if (sessions.size >= MAX_SESSIONS) {
            return reply(res, 503, { error: "session limit reached, retry later" });
          }
          if (sessionsOf(key) >= MAX_SESSIONS_PER_KEY) {
            return reply(res, 429, { error: `too many concurrent sessions for this key (max ${MAX_SESSIONS_PER_KEY})` });
          }
          transport = await newSession(key);
        }
        return void (await transport.handleRequest(req, res, body));
      }

      // GET = server-initiated SSE stream, DELETE = session teardown
      if (req.method === "GET" || req.method === "DELETE") {
        if (!sid) return reply(res, 400, { error: "mcp-session-id header required" });
        if (!session) return reply(res, 404, { error: "unknown or expired session" });
        return void (await session.transport.handleRequest(req, res));
      }

      return reply(res, 405, { error: "method not allowed" });
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) reply(res, err.status, { error: err.message });
        return;
      }
      // internals (liteserver hosts, config URLs) belong in the log, not the response
      console.error(`${new Date().toISOString()} ERROR ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) reply(res, 500, { error: "internal server error" });
    } finally {
      if (req.url !== "/healthz") logLine(req, res, key, sid);
    }
  });

  httpServer.listen(PORT, HOST, () => {
    const mode = OPEN_MODE ? "open access (explicitly allowed)" : `${KEYS.size} API key(s)`;
    const globalNote = GLOBAL_RATE_LIMIT_RPM > 0 ? `, global cap ${GLOBAL_RATE_LIMIT_RPM}/min` : "";
    console.error(
      `tonnode-mcp http listening on ${HOST}:${PORT} — ${mode}, ${RATE_LIMIT_RPM} req/min per key by default${globalNote}, ` +
        `session TTL ${SESSION_TTL_MS / 60_000} min`
    );
  });

  // Graceful shutdown under systemd: stop accepting, tear down sessions, exit.
  const shutdown = () => {
    httpServer.close();
    for (const [id, s] of sessions) {
      sessions.delete(id);
      s.transport.close().catch(() => {});
    }
    setTimeout(() => process.exit(0), 3_000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
