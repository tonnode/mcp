// The per-key source-address allowlist, exercised over real HTTP.
//
// The structural test next door asserts the `ips` field survives loading. This
// one asserts the thing customers actually care about: a key restricted to an
// address is REFUSED from anywhere else and ACCEPTED from that address. The
// bug it guards was invisible to every other kind of check — the field was
// parsed, validated, written and displayed, and then silently dropped one line
// before the only code that reads it.
//
// A real server on a real port, because the drop happened between the file and
// the auth path and only an end-to-end request crosses that boundary.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "tonnode-allow-"));
const keysFile = join(dir, "keys.json");
const PORT = 8899;

const ALLOWED = "203.0.113.10";
const BLOCKED = "198.51.100.7";

writeFileSync(
  keysFile,
  JSON.stringify([
    { key: "tn_live_restricted", label: "restricted", rpm: 600, ips: [ALLOWED] },
    { key: "tn_live_cidr", label: "cidr", rpm: 600, ips: ["203.0.113.0/24"] },
    { key: "tn_live_open", label: "open", rpm: 600 }, // no allowlist: any address
  ])
);

process.env.TONNODE_KEYS_FILE = keysFile;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

before(async () => {
  const { startHttp } = await import("../dist/http.js");
  startHttp();
  // Give the listener a moment to bind.
  await new Promise((r) => setTimeout(r, 400));
});

// No `after` hook killing the process: the listener keeps the event loop
// alive, so the runner is given --test-force-exit instead. Calling
// process.exit() here truncated the report and silently dropped the last
// test's result — it had run and passed, and the summary said five of six.

/** One initialize call, as the given key, apparently from the given address. */
async function attempt(key, ip) {
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${key}`,
      // The proxy-written entry is the last one; see clientIp().
      "X-Forwarded-For": ip,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
    }),
  });
  return res.status;
}

test("a restricted key is refused from an address outside its allowlist", async () => {
  const status = await attempt("tn_live_restricted", BLOCKED);
  assert.equal(status, 401, `expected 401 from ${BLOCKED}, got ${status} — the allowlist is not enforced`);
});

test("a restricted key is accepted from an address inside its allowlist", async () => {
  const status = await attempt("tn_live_restricted", ALLOWED);
  assert.notEqual(status, 401, `expected the key to work from ${ALLOWED}, got 401 — the allowlist locks out its owner`);
});

test("a CIDR rule admits an address in range and refuses one outside", async () => {
  assert.notEqual(await attempt("tn_live_cidr", "203.0.113.99"), 401, "203.0.113.99 is inside 203.0.113.0/24");
  assert.equal(await attempt("tn_live_cidr", "203.0.114.1"), 401, "203.0.114.1 is outside 203.0.113.0/24");
});

test("a key with no allowlist still works from anywhere", async () => {
  // The field is optional and absent means unrestricted — every key issued
  // before allowlists existed relies on this.
  for (const ip of [ALLOWED, BLOCKED, "8.8.8.8"]) {
    assert.notEqual(await attempt("tn_live_open", ip), 401, `an unrestricted key was refused from ${ip}`);
  }
});

test("an unknown key is refused wherever it comes from", async () => {
  assert.equal(await attempt("tn_live_nope", ALLOWED), 401);
});

test("the last forwarded entry decides, so a prepended one cannot bypass", async () => {
  // If an appending proxy is ever put in front, the client controls the FIRST
  // entry. Reading that one would let anyone claim an allowlisted address.
  const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer tn_live_restricted",
      "X-Forwarded-For": `${ALLOWED}, ${BLOCKED}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }),
  });
  assert.equal(
    res.status,
    401,
    "the allowlisted address was claimed by prepending it to X-Forwarded-For — " +
      "clientIp must read the entry our own proxy wrote, which is the last one"
  );
});
