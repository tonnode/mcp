#!/usr/bin/env bash
# Manage API keys for tonnode-mcp without restarting the service.
# The server watches TONNODE_KEYS_FILE and reloads it within ~5 seconds.
#
#   tonnode-keys.sh list
#   tonnode-keys.sh add <label> [rpm] [days]     # e.g. add acme-corp 300 30
#   tonnode-keys.sh revoke <label-or-key-prefix>
#
set -euo pipefail

FILE="${TONNODE_KEYS_FILE:-/etc/tonnode-mcp.keys.json}"
CMD="${1:-list}"

[ -f "$FILE" ] || { echo "[]" > "$FILE"; chmod 600 "$FILE"; }

case "$CMD" in
  list)
    node -e '
      const f = process.argv[1];
      const keys = JSON.parse(require("fs").readFileSync(f, "utf-8"));
      if (!keys.length) { console.log("no keys"); process.exit(0); }
      const now = Date.now();
      for (const k of keys) {
        const exp = k.expires ? (Date.parse(k.expires) < now ? `EXPIRED ${k.expires}` : `until ${k.expires}`) : "no expiry";
        console.log(`${(k.label ?? "-").padEnd(20)} ${k.key.slice(0, 16)}…  ${String(k.rpm ?? "default").padEnd(8)} ${exp}`);
      }' "$FILE"
    ;;
  add)
    LABEL="${2:?usage: add <label> [rpm] [days]}"
    RPM="${3:-}"
    DAYS="${4:-}"
    KEY="tn_live_$(openssl rand -hex 24)"
    node -e '
      const [f, key, label, rpm, days] = process.argv.slice(1);
      const fs = require("fs");
      const keys = JSON.parse(fs.readFileSync(f, "utf-8"));
      if (keys.some(k => k.label === label)) { console.error(`label "${label}" already exists — revoke it first`); process.exit(1); }
      const rec = { key, label };
      if (rpm) rec.rpm = Number(rpm);
      if (days) rec.expires = new Date(Date.now() + Number(days) * 86400_000).toISOString().slice(0, 10);
      keys.push(rec);
      fs.writeFileSync(f, JSON.stringify(keys, null, 2) + "\n");
      console.log(`added: ${label}${rec.rpm ? ` (${rec.rpm}/min)` : ""}${rec.expires ? ` (expires ${rec.expires})` : ""}`);
      console.log(`key (shown once, give to the customer): ${key}`);
    ' "$FILE" "$KEY" "$LABEL" "$RPM" "$DAYS"
    ;;
  revoke)
    MATCH="${2:?usage: revoke <label-or-key-prefix>}"
    node -e '
      const [f, m] = process.argv.slice(1);
      const fs = require("fs");
      const keys = JSON.parse(fs.readFileSync(f, "utf-8"));
      const keep = keys.filter(k => k.label !== m && !k.key.startsWith(m));
      if (keep.length === keys.length) { console.error(`nothing matches "${m}"`); process.exit(1); }
      fs.writeFileSync(f, JSON.stringify(keep, null, 2) + "\n");
      console.log(`revoked ${keys.length - keep.length} key(s) — server picks it up within ~5s, live sessions are closed`);
    ' "$FILE" "$MATCH"
    ;;
  *)
    echo "usage: $0 list | add <label> [rpm] [days] | revoke <label-or-key-prefix>" >&2
    exit 1
    ;;
esac
