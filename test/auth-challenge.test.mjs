// A 401 must say how to authenticate, not just that you failed.
//
// The server rejected every unauthenticated request with a bare 401: no
// `WWW-Authenticate`, which RFC 9110 requires and RFC 6750 shapes for bearer
// tokens. A client probing the endpoint learned nothing and stopped — Smithery
// logged 197 sessions and zero tool calls against production, which is what
// that looks like from the outside.
//
// This is a behavioural test against the real server rather than a grep of the
// source, because the thing that broke was a response header, and only a
// response can prove a response.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const dir = mkdtempSync(join(tmpdir(), "tonnode-mcp-auth-"));
const keysFile = join(dir, "keys.json");
writeFileSync(keysFile, JSON.stringify([{ key: "tn_live_valid", label: "test", rpm: 60 }]));

// A port nobody else in the suite uses; the server binds loopback only.
const PORT = 8871;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
process.env.TONNODE_KEYS_FILE = keysFile;
// Without this the server would decide it is unconfigured and open to all.
delete process.env.TONNODE_KEYS;

const { startHttp } = await import("../dist/http.js");
startHttp();
// Give the listener a tick to bind.
await new Promise((r) => setTimeout(r, 300));

const URL_MCP = `http://127.0.0.1:${PORT}/mcp`;
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
});

async function post(headers = {}) {
  return fetch(URL_MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: INIT,
  });
}

test("a request with no credentials is challenged, not just refused", async () => {
  const res = await post();
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate");
  assert.ok(challenge, "401 carried no WWW-Authenticate — the client cannot learn the scheme");
  assert.match(challenge, /^Bearer /, "the scheme must be named first so a client can parse it");
  assert.match(challenge, /realm="TONNode MCP"/);
  // Nothing was offered, so this is guidance, not a rejection verdict.
  assert.ok(!challenge.includes('error="invalid_token"'), "a missing key is not an invalid one");
  assert.match(challenge, /error_description="[^"]*Bearer/, "the description must show the header to send");
});

test("a rejected key is reported as invalid_token, which is a different problem", async () => {
  const res = await post({ Authorization: "Bearer tn_live_wrong" });
  assert.equal(res.status, 401);
  const challenge = res.headers.get("www-authenticate");
  assert.ok(challenge);
  assert.match(challenge, /error="invalid_token"/, "a key that was sent and rejected must be distinguishable from none");
  assert.match(challenge, /error_description="[^"]*dashboard/, "tell them where a working key comes from");
});

test("the body stays machine- and human-readable", async () => {
  const body = await (await post()).json();
  assert.equal(body.error, "invalid, missing or expired API key");
  assert.match(body.hint, /Authorization: Bearer/);
  assert.ok(body.docs.startsWith("https://tonnode.io/"));
});

test("a valid key still gets through — the challenge did not break auth", async () => {
  const res = await post({ Authorization: "Bearer tn_live_valid" });
  assert.notEqual(res.status, 401);
  assert.equal(res.headers.get("www-authenticate"), null, "a served request must carry no challenge");
});
