// TONNODE_USAGE_LOG: one JSON line per request to /mcp, ingested by the admin
// panel. Over real HTTP, because the line is written after the response has
// finished and only a real response gets there.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "tonnode-usage-"));
const keysFile = join(dir, "keys.json");
const logFile = join(dir, "usage.jsonl");
const PORT = 8873;
const URL_BASE = `http://127.0.0.1:${PORT}`;

// Production-shaped keys (tn_live_ + 48 hex).
const KEY = "tn_live_" + "a1".repeat(24);
const SLOW = "tn_live_" + "b2".repeat(24); // rpm 1: the second request is a 429
const WRONG = "tn_live_" + "c3".repeat(24); // not in the registry
const hint = (k) => `${k.slice(0, 11)}…${k.slice(-4)}`;

writeFileSync(
  keysFile,
  JSON.stringify([
    { key: KEY, label: "customer-1", rpm: 600 },
    { key: SLOW, label: "slow", rpm: 1 },
  ])
);

process.env.TONNODE_KEYS_FILE = keysFile;
process.env.TONNODE_USAGE_LOG = logFile;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
delete process.env.TONNODE_KEYS;

before(async () => {
  const { startHttp } = await import("../dist/http.js");
  startHttp();
  await new Promise((r) => setTimeout(r, 300));
});

const FIELDS = ["ts", "ms", "http", "status", "rpc", "id", "tool", "args", "key_label", "key_hint", "sid", "ip", "ua"];
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function lines() {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** The lines appended since `from`, once at least `n` of them are there (writes are async). */
async function newLines(from, n) {
  const deadline = Date.now() + 3000;
  while (lines().length < from + n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return lines().slice(from);
}

async function post(body, headers = {}) {
  const res = await fetch(`${URL_BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": "usage-test/1.0",
      "X-Forwarded-For": "203.0.113.5",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text(); // drain: the line is written after "finish"
  return { res, text };
}

/** initialize + notifications/initialized; returns the session id once both lines are written. */
async function openSession(key) {
  const from = lines().length;
  const { res } = await post(INIT, { Authorization: `Bearer ${key}` });
  assert.equal(res.status, 200);
  const sid = res.headers.get("mcp-session-id");
  assert.ok(sid, "initialize returned no session id");
  const note = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, { Authorization: `Bearer ${key}`, "mcp-session-id": sid });
  assert.equal(note.res.status, 202);
  assert.equal((await newLines(from, 2)).length, 2);
  return sid;
}

test("one line per call, with the fields the admin panel reads", async () => {
  const from = lines().length;
  const sid = await openSession(KEY);
  const address = "0:" + "0".repeat(64);
  const call = await post(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "parse_address", arguments: { address } } },
    { Authorization: `Bearer ${KEY}`, "mcp-session-id": sid }
  );
  assert.equal(call.res.status, 200);
  assert.match(call.text, /friendly_bounceable/, "the tool call itself did not succeed");

  const got = await newLines(from, 3);
  assert.equal(got.length, 3, "expected exactly one line per HTTP request");
  for (const l of got) {
    assert.deepEqual(Object.keys(l), FIELDS);
    assert.equal(new Date(l.ts).toISOString(), l.ts, "ts must be an ISO timestamp");
    assert.ok(Number.isInteger(l.ms) && l.ms >= 0);
    assert.equal(l.http, "POST");
    assert.equal(l.key_label, "customer-1");
    assert.equal(l.key_hint, hint(KEY));
    assert.equal(l.ip, "203.0.113.5");
    assert.equal(l.ua, "usage-test/1.0");
  }
  const [init, note, tool] = got;
  assert.deepEqual(
    { status: init.status, rpc: init.rpc, id: init.id, tool: init.tool, args: init.args, sid: init.sid },
    { status: 200, rpc: "initialize", id: 1, tool: null, args: null, sid: null }
  );
  assert.deepEqual(
    { status: note.status, rpc: note.rpc, id: note.id, tool: note.tool, sid: note.sid },
    { status: 202, rpc: "notifications/initialized", id: null, tool: null, sid: sid.slice(0, 8) }
  );
  assert.deepEqual(
    { status: tool.status, rpc: tool.rpc, id: tool.id, tool: tool.tool, args: tool.args, sid: tool.sid },
    { status: 200, rpc: "tools/call", id: 2, tool: "parse_address", args: JSON.stringify({ address }), sid: sid.slice(0, 8) }
  );
});

test("arguments are cut to 400 characters and the user agent to 120", async () => {
  const sid = await openSession(KEY);
  const from = lines().length;
  await post(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "parse_address", arguments: { address: "x".repeat(5000) } } },
    { Authorization: `Bearer ${KEY}`, "mcp-session-id": sid, "User-Agent": "u".repeat(500) }
  );
  const [l] = await newLines(from, 1);
  assert.equal(l.args.length, 400);
  assert.ok(l.args.startsWith('{"address":"xxx'));
  assert.equal(l.ua.length, 120);
});

test("every string the client controls is clipped, so a near-1 MB request writes a short line", async () => {
  const sid = await openSession(KEY);
  const from = lines().length;
  const big = (c) => c.repeat(300_000);
  // No session: the body is read and then refused with a 400.
  const refused = await post({ jsonrpc: "2.0", id: big("i"), method: big("m") }, { Authorization: `Bearer ${KEY}` });
  assert.equal(refused.res.status, 400);
  // In a session: a tools/call with a huge tool name, behind a huge X-Forwarded-For.
  await post(
    { jsonrpc: "2.0", id: big("j"), method: "tools/call", params: { name: big("t"), arguments: {} } },
    { Authorization: `Bearer ${KEY}`, "mcp-session-id": sid, "X-Forwarded-For": "9".repeat(8000) }
  );

  const got = await newLines(from, 2);
  assert.equal(got.length, 2);
  for (const raw of readFileSync(logFile, "utf8").split("\n").filter(Boolean).slice(from)) {
    assert.ok(Buffer.byteLength(raw) < 2048, `a ${Buffer.byteLength(raw)}-byte line was written`);
  }
  assert.equal(got[0].status, 400);
  assert.equal(got[0].rpc.length, 100);
  assert.ok(got[0].rpc.startsWith("mmm"));
  assert.equal(got[0].id.length, 100);
  assert.equal(got[1].rpc, "tools/call");
  assert.equal(got[1].tool.length, 100);
  assert.ok(got[1].tool.startsWith("ttt"));
  assert.equal(got[1].id.length, 100);
  assert.equal(got[1].ip.length, 64);
});

test("a 413 with no X-Forwarded-For is logged with the socket address", async () => {
  // Node detaches the socket before "finish" on this path, so the address
  // must have been read when the request arrived.
  const from = lines().length;
  await new Promise((resolve) => {
    const req = request(
      { host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` } },
      (res) => {
        res.resume();
        res.on("end", resolve);
      }
    );
    req.on("error", resolve); // the server may close before the client has sent everything
    req.end("x".repeat(1_100_000));
  });
  const [l] = await newLines(from, 1);
  assert.ok(l, "no line was written for the 413");
  assert.equal(l.status, 413);
  assert.equal(l.ip, "127.0.0.1");
  assert.equal(l.key_label, "customer-1");
  assert.equal(l.rpc, null);
});

test("refused requests are logged: 401 with a hint of what was offered, 429 with the label", async () => {
  const from = lines().length;
  assert.equal((await post(INIT, { Authorization: `Bearer ${WRONG}` })).res.status, 401);
  assert.equal((await post(INIT, { "X-API-Key": WRONG })).res.status, 401);
  assert.equal((await post(INIT, { Authorization: "Bearer tn_live_short" })).res.status, 401);
  assert.equal((await post(INIT)).res.status, 401);
  assert.equal((await post(INIT, { Authorization: `Bearer ${SLOW}` })).res.status, 200);
  assert.equal((await post(INIT, { Authorization: `Bearer ${SLOW}` })).res.status, 429);

  const got = await newLines(from, 6);
  assert.equal(got.length, 6);
  const view = got.map((l) => [l.status, l.key_label, l.key_hint]);
  assert.deepEqual(view, [
    [401, null, hint(WRONG)],
    [401, null, hint(WRONG)],
    [401, null, null], // shorter than 20 chars: no hint at all
    [401, null, null], // nothing offered
    [200, "slow", hint(SLOW)],
    [429, "slow", hint(SLOW)],
  ]);
  // A refused request is answered before its body is read.
  assert.equal(got[0].rpc, null);
  assert.equal(got[0].http, "POST");
});

test("/healthz and other paths are not logged", async () => {
  const from = lines().length;
  assert.equal((await fetch(`${URL_BASE}/healthz`)).status, 200);
  assert.equal((await fetch(`${URL_BASE}/nope`)).status, 404);
  // Writes are ordered, so if either were logged it would land before this one.
  await post(INIT);
  const got = await newLines(from, 1);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lines().length, from + 1);
  assert.equal(got[0].status, 401);
});

test("the full key never appears in the file", async () => {
  const text = readFileSync(logFile, "utf8");
  for (const k of [KEY, SLOW, WRONG]) {
    assert.ok(!text.includes(k), `a full key was written to the usage log`);
    assert.ok(!text.includes(k.slice(11, -4)), `the middle of a key was written to the usage log`);
  }
  assert.ok(text.includes(hint(KEY)), "sanity: the hint is there");
});
