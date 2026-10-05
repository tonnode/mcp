// A usage log the disk cannot take must cost bounded memory. appendFile is
// replaced (before the server is loaded) by one that never finishes until the
// test opens the gate, so the writer stalls on its first batch: at most
// 10,000 lines may wait behind it, the rest are dropped and reported once,
// and no response changes.
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import { mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { before } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "tonnode-usage-queue-"));
const keysFile = join(dir, "keys.json");
const PORT = 8875;
const MAX_PENDING = 10_000; // USAGE_MAX_PENDING in src/http.ts
const FLOOD = MAX_PENDING + 1_500;

writeFileSync(keysFile, JSON.stringify([{ key: "tn_live_" + "e5".repeat(24), label: "customer", rpm: 600 }]));
process.env.TONNODE_KEYS_FILE = keysFile;
process.env.TONNODE_USAGE_LOG = join(dir, "usage.jsonl");
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";
delete process.env.TONNODE_KEYS;

// Every appendFile call records what it was given and then waits for the gate.
const batches = [];
let openGate;
const gate = new Promise((r) => (openGate = r));
fsp.appendFile = async (_path, data) => {
  batches.push(String(data));
  await gate;
};
syncBuiltinESMExports();

// Keep what the logger says about itself; drop the per-request console lines.
const usageErrors = [];
console.error = (...a) => {
  const s = a.join(" ");
  if (s.includes("usage log:")) usageErrors.push(s);
};

before(async () => {
  const { startHttp } = await import("../dist/http.js");
  startHttp();
  await new Promise((r) => setTimeout(r, 300));
});

const lineCount = (s) => s.split("\n").length - 1;

test("a stalled writer keeps at most 10,000 lines and drops the rest; responses do not change", async () => {
  const statuses = {};
  let sent = 0;
  async function worker() {
    while (sent < FLOOD) {
      sent++;
      const res = await fetch(`http://127.0.0.1:${PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer tn_live_not_a_key_00000000000000" },
        body: "{}",
      });
      await res.arrayBuffer();
      statuses[res.status] = (statuses[res.status] ?? 0) + 1;
    }
  }
  await Promise.all(Array.from({ length: 32 }, worker));
  assert.deepEqual(statuses, { 401: FLOOD });

  // The first line went to the writer, which is stalled on it.
  assert.equal(batches.length, 1);
  assert.equal(lineCount(batches[0]), 1);
  assert.equal(usageErrors.length, 1, `expected one console line, got ${usageErrors.length}`);
  assert.match(usageErrors[0], /queue full \(10000 lines waiting for the disk\); 1 line\(s\) dropped so far/);

  // Released, the writer appends everything that waited in one call.
  openGate();
  const deadline = Date.now() + 3000;
  while (batches.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(batches.length, 2);
  assert.equal(lineCount(batches[1]), MAX_PENDING);
  for (const l of batches[1].split("\n").filter(Boolean)) assert.equal(JSON.parse(l).status, 401);
});
