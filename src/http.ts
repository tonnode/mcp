#!/usr/bin/env node
// Hosted mode: the same TON MCP server over Streamable HTTP.
//
//   PORT=8808 TONNODE_KEYS=tn_live_abc,tn_live_def tonnode-mcp-http
//
// Clients connect with:
//   { "mcpServers": { "ton": { "url": "https://mcp.tonnode.io/mcp",
//                              "headers": { "Authorization": "Bearer tn_live_abc" } } } }
//
// With TONNODE_KEYS unset the server runs open — fine for self-hosting
// behind your own firewall, not for the public internet.

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createTonServer } from "./server.js";

const PORT = Number(process.env.PORT ?? 8808);
const KEYS = new Set(
  (process.env.TONNODE_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);
const RATE_LIMIT_RPM = Number(process.env.RATE_LIMIT_RPM ?? 300);

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
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_048_576) throw new Error("body too large");
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : undefined;
}

// ---------- session registry ----------

const transports = new Map<string, StreamableHTTPServerTransport>();

async function newSession(): Promise<StreamableHTTPServerTransport> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      transports.set(id, transport);
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) transports.delete(transport.sessionId);
  };
  await createTonServer().connect(transport);
  return transport;
}

// ---------- http server ----------

const httpServer = createHttpServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");

    if (req.method === "GET" && url.pathname === "/healthz") {
      return reply(res, 200, { ok: true, sessions: transports.size });
    }

    if (url.pathname !== "/mcp") {
      return reply(res, 404, { error: "not found — MCP endpoint is POST /mcp" });
    }

    const key = authenticate(req);
    if (!key) return reply(res, 401, { error: "invalid or missing API key" });
    if (!allow(key)) return reply(res, 429, { error: `rate limit exceeded (${RATE_LIMIT_RPM}/min)` });

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST") {
      const body = await readBody(req);
      let transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) {
        if (sessionId) return reply(res, 404, { error: "unknown or expired session" });
        transport = await newSession();
      }
      return void (await transport.handleRequest(req, res, body));
    }

    // GET = server-initiated SSE stream, DELETE = session teardown
    if (req.method === "GET" || req.method === "DELETE") {
      const transport = sessionId ? transports.get(sessionId) : undefined;
      if (!transport) return reply(res, 400, { error: "mcp-session-id header required" });
      return void (await transport.handleRequest(req, res));
    }

    return reply(res, 405, { error: "method not allowed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!res.headersSent) reply(res, 500, { error: message });
  }
});

httpServer.listen(PORT, () => {
  const mode = KEYS.size > 0 ? `${KEYS.size} API key(s)` : "open access (no TONNODE_KEYS set)";
  console.error(`tonnode-mcp http listening on :${PORT} — ${mode}, ${RATE_LIMIT_RPM} req/min per key`);
});
