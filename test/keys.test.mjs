// The key registry, and the projection that silently disarmed it.
//
// `loadKeys` parses the registry file into a Map of KeyRecord. It built each
// entry by naming fields one at a time — and `ips` was not among them. So the
// allowlist check further down could never fire for a key loaded from the
// file, which is every key in production: billing validated the addresses,
// wrote them into the registry, and the console showed the key as restricted
// while the server served it from anywhere.
//
// Nothing failed. There is no error path for "silently ignored a security
// field", which is why this test is structural: it asserts that every field
// the auth path reads survives the load.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const src = readFileSync(new URL("../src/http.ts", import.meta.url), "utf8");

/** Field names declared on the KeyRecord type. */
function declaredFields() {
  const block = src.match(/type KeyRecord = \{([\s\S]*?)\n\};/);
  assert.ok(block, "KeyRecord type not found — this test is stale");
  return [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
}

/** Field names the file->Map projection actually copies. */
function projectedFields() {
  const line = src.match(/\.map\(\(e\) => \[e\.key, \{([^}]*)\}\]\)/);
  assert.ok(line, "the registry projection was not found — this test is stale");
  return [...line[1].matchAll(/(\w+):\s*e\.\w+/g)].map((m) => m[1]);
}

test("every KeyRecord field survives loading from the registry file", () => {
  const declared = declaredFields();
  const projected = projectedFields();
  assert.ok(declared.length > 0, "no fields parsed from KeyRecord");

  const dropped = declared.filter((f) => !projected.includes(f));
  assert.deepEqual(
    dropped,
    [],
    `these fields are declared on KeyRecord and dropped when the registry is loaded: ` +
      `${dropped.join(", ")}. A field the auth path reads but the loader discards is a ` +
      `restriction that appears to be set and is not enforced.`
  );
});

test("the allowlist is still checked in the auth path", () => {
  // If this check is ever removed, the projection above becomes pointless and
  // the previous test would keep passing while nothing is enforced.
  assert.match(
    src,
    /if \(rec\.ips && rec\.ips\.length > 0\)/,
    "the source-address check is gone from the auth path"
  );
});

test("expiry is still checked in the auth path", () => {
  // Same reasoning: a plan that has ended must stop the key.
  assert.match(
    src,
    /rec\.expires && Date\.parse\(rec\.expires\) < Date\.now\(\)/,
    "expired keys are no longer refused"
  );
});
