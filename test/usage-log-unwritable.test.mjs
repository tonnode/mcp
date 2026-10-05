// A usage log that cannot be written must not change a single response.
// The path sits under a directory that does not exist, so every append fails
// (ENOENT) — also when the suite runs as root, where a chmod would not.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "tonnode-usage-bad-"));
const keysFile = join(dir, "keys.json");
const logFile = join(dir, "no-such-dir", "usage.jsonl");
const PORT = 8874;
const KEY = "tn_live_" + "d4".repeat(24);

writeFileSync(keysFile, JSON.stringify([{ key: KEY, label: "customer", rpm: 600 }]));
process.env.TONNODE_KEYS_FILE = keysFile;
process.env.TONNODE_USAGE_LOG = logFile;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
delete process.env.TONNODE_KEYS;

// Count what the logger says about its failures.
const usageErrors = [];
const consoleError = console.error;
console.error = (...a) => {
  if (String(a[0]).includes("usage log:")) usageErrors.push(a.join(" "));
  else consoleError(...a);
};

before(async () => {
  const { startHttp } = await import("../dist/http.js");
  startHttp();
  await new Promise((r) => setTimeout(r, 300));
});

async function post(body, headers = {}) {
  return fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

test("requests are served normally while every write fails", async () => {
  const init = await post(INIT, { Authorization: `Bearer ${KEY}` });
  assert.equal(init.status, 200);
  const sid = init.headers.get("mcp-session-id");
  assert.ok(sid);
  assert.match(await init.text(), /"serverInfo"/);

  assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { Authorization: `Bearer ${KEY}`, "mcp-session-id": sid })).status, 202);

  const call = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "parse_address", arguments: { address: "0:" + "0".repeat(64) } } },
    { Authorization: `Bearer ${KEY}`, "mcp-session-id": sid }
  );
  assert.equal(call.status, 200);
  assert.match(await call.text(), /friendly_bounceable/);

  const refused = await post(INIT, { Authorization: "Bearer tn_live_wrong_key_0000000000" });
  assert.equal(refused.status, 401);
  assert.match(refused.headers.get("www-authenticate") ?? "", /error="invalid_token"/);
  assert.equal((await refused.json()).error, "invalid, missing or expired API key");

  assert.equal((await fetch(`http://127.0.0.1:${PORT}/healthz`)).status, 200);
});

test("the failure is reported at most once a minute, and nothing is created", async () => {
  await new Promise((r) => setTimeout(r, 300)); // let the queued appends fail
  assert.equal(usageErrors.length, 1, `expected one console line, got ${usageErrors.length}`);
  assert.match(usageErrors[0], /ENOENT/);
  assert.equal(existsSync(logFile), false);
});
