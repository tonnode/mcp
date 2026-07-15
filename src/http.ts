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

type KeyRecord = { rpm?: number; expires?: string; label?: string };

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
          .map((e) => [e.key, { rpm: e.rpm, expires: e.expires, label: e.label }])
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

function authenticate(req: IncomingMessage): string | null {
  if (OPEN_MODE) return "open";
  if (KEYS.size === 0) return null; // keys file emptied at runtime → locked, not open
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!match) return null;
  const key = match[1].trim();
  const rec = KEYS.get(key);
  if (!rec) return null;
  if (rec.expires && Date.parse(rec.expires) < Date.now()) return null;
  return key;
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res
    .writeHead(status, {
      "Content-Type": "application/json",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    })
    .end(JSON.stringify(body));
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

// ---------- http server ----------

function logLine(req: IncomingMessage, res: ServerResponse, key: string | null, sid?: string) {
  const keyTag = key === null ? "-" : key === "open" ? "open" : key.slice(0, 11) + "…";
  console.error(
    `${new Date().toISOString()} ${req.method} ${req.url} ${res.statusCode} key=${keyTag}${sid ? ` sid=${sid.slice(0, 8)}` : ""}`
  );
}

export function startHttp(): void {
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
      if (!key) return reply(res, 401, { error: "invalid, missing or expired API key" });
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
