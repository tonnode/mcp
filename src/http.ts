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
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { createTonServer } from "./server.js";

const HOST = process.env.HOST ?? "127.0.0.1";
const PORT = Number(process.env.PORT ?? 8808);
const KEYS = new Set(
  (process.env.TONNODE_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 300);
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MIN ?? 30) * 60_000;
const MAX_SESSIONS = Number(process.env.MAX_SESSIONS ?? 500);
const MAX_SESSIONS_PER_KEY = Number(process.env.MAX_SESSIONS_PER_KEY ?? 50);

// ---------- auth + per-key token bucket ----------

const buckets = new Map<string, { tokens: number; stamp: number }>();

function allow(key: string): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: RATE_LIMIT_RPM, stamp: now };
  bucket.tokens = Math.min(
    RATE_LIMIT_RPM,
    bucket.tokens + ((now - bucket.stamp) / 60_000) * RATE_LIMIT_RPM
  );
  bucket.stamp = now;
  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }
  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

function authenticate(req: IncomingMessage): string | null {
  if (KEYS.size === 0) return "open";
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? "");
  if (!match || !KEYS.has(match[1].trim())) return null;
  return match[1].trim();
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
  // fail closed: a typo'd env var must not silently expose an open server
  if (KEYS.size === 0 && process.env.TONNODE_ALLOW_OPEN !== "1") {
    console.error(
      "tonnode-mcp: refusing to start --http without TONNODE_KEYS. " +
        "Set TONNODE_KEYS=key1,key2 or explicitly opt in to open access with TONNODE_ALLOW_OPEN=1."
    );
    process.exit(1);
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
      if (!key) return reply(res, 401, { error: "invalid or missing API key" });
      if (!allow(key)) return reply(res, 429, { error: `rate limit exceeded (${RATE_LIMIT_RPM}/min)` });

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
    const mode = KEYS.size > 0 ? `${KEYS.size} API key(s)` : "open access (no TONNODE_KEYS set)";
    console.error(
      `tonnode-mcp http listening on ${HOST}:${PORT} — ${mode}, ${RATE_LIMIT_RPM} req/min per key, ` +
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
