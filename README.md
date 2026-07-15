# @tonnode/mcp

[![mcp MCP server](https://glama.ai/mcp/servers/tonnode/mcp/badges/score.svg)](https://glama.ai/mcp/servers/tonnode/mcp)

[Русская версия](README.ru.md)

MCP server that gives AI agents direct **liteserver** access to [The Open Network (TON)](https://ton.org) — no HTTP gateways in the middle. Balances, account state, transaction history and contract get-methods over TON's native ADNL protocol.

Built by [TONNode](https://tonnode.io) — private TON liteservers, archive nodes, mempool stream and indexed API.

## Quick start

Add to Claude Desktop, Claude Code, ChatGPT, Cursor, Codex or any MCP client:

```json
{
  "mcpServers": {
    "ton": {
      "command": "npx",
      "args": ["-y", "@tonnode/mcp"]
    }
  }
}
```

That's the whole integration. The server connects to TON mainnet via the public global config by default. Ready-made configs for every client — plus programmatic Node.js usage — live in [examples/](examples/).

## Tools

> **Naming note:** the native coin was renamed from Toncoin to **GRAM** in June 2026; the network itself is still called **TON**. Tool outputs use `*_gram` fields.

| Tool | What it does | Typical question |
|---|---|---|
| `get_balance` | GRAM balance of an address | *"How much GRAM does EQ… hold?"* |
| `get_jetton_balance` | Jetton/token balance (USDT and any TEP-74 token) | *"How much USDT is on this wallet?"* |
| `get_transactions` | Recent transactions: values, senders, fees | *"Did my payment arrive?"* |
| `get_account_state` | Status, deployment flags, last-tx pointer | *"Is this contract deployed?"* |
| `run_get_method` | Read-only get-methods on contracts | *"Call `get_jetton_data` on this master"* |
| `parse_address` | Convert/validate EQ…/UQ…/raw forms, offline | *"Are these two addresses the same?"* |
| `get_masterchain_info` | Masterchain head: seqno, shard, hashes | *"Is the network (or my endpoint) alive?"* |

## Hosted / self-hosted HTTP mode

The package also ships a Streamable-HTTP entry for remote deployments (this is what powers `mcp.tonnode.io`):

```bash
TONNODE_KEYS=tn_live_abc,tn_live_def PORT=8808 npx -y @tonnode/mcp --http
```

Clients then connect without installing anything:

```json
{
  "mcpServers": {
    "ton": {
      "url": "https://your-host/mcp",
      "headers": { "Authorization": "Bearer tn_live_abc" }
    }
  }
}
```

Requests are authenticated with Bearer keys and rate-limited per key (`RATE_LIMIT_RPM`, default 300). Besides `Authorization: Bearer <key>`, the server accepts a bare `Authorization: <key>` and `X-API-Key: <key>` — for gateways (e.g. Smithery) that reserve the `Authorization` header for themselves. Keys come from either `TONNODE_KEYS` (comma-separated, fixed) or `TONNODE_KEYS_FILE` — a JSON array of `{"key", "label"?, "rpm"?, "expires"?}` that is **hot-reloaded** on change and on SIGHUP: add or revoke customer keys with no restart, per-key rate limits, and self-expiring keys for subscription plans. A revoked key's live sessions are closed immediately. `GLOBAL_RATE_LIMIT_RPM` adds a total ceiling across all keys to protect the backend liteserver. Sessions are private to the key that opened them, idle sessions are swept after `SESSION_TTL_MIN` (default 30 minutes), and concurrent sessions are capped per key and globally. Without keys the server refuses to start; set `TONNODE_ALLOW_OPEN=1` to explicitly run keyless behind your own firewall. `GET /healthz` for monitoring, [`deploy/tonnode-keys.sh`](deploy/tonnode-keys.sh) for key management.

The server binds `127.0.0.1` by default — put a TLS reverse proxy (Caddy, nginx) in front and set `HOST=0.0.0.0` only if the proxy runs on another machine. Ready-made systemd + Caddy configs live in [`deploy/`](deploy/).

## Configuration

| Env var | Meaning |
|---|---|
| `TON_LITESERVERS` | Use your own liteservers instead of the public config: `[{"ip":"1.2.3.4","port":40004,"key":"<base64 ed25519>"}]` |
| `TON_CONFIG_URL` | Alternative global-config URL |
| `TON_NETWORK=testnet` | Use the testnet config (or pass `--testnet`) |
| `TONNODE_KEYS` | HTTP mode: comma-separated Bearer API keys (simple, fixed) |
| `TONNODE_KEYS_FILE` | HTTP mode: JSON key file with labels, per-key `rpm`, `expires` — hot-reloaded |
| `HOST` | HTTP mode: bind address (default `127.0.0.1`) |
| `PORT` | HTTP mode: listen port (default 8808) |
| `RATE_LIMIT_RPM` | HTTP mode: default requests per minute per key (default 300) |
| `GLOBAL_RATE_LIMIT_RPM` | HTTP mode: total ceiling across all keys (default off) |
| `SESSION_TTL_MIN` | HTTP mode: idle minutes before a session is swept (default 30) |
| `MAX_SESSIONS` / `MAX_SESSIONS_PER_KEY` | HTTP mode: concurrent session caps (default 500 / 50) |

### A note on public liteservers

The default public-config liteservers are shared, rate-limited and keep **no deep history** — `get_transactions` beyond recent blocks will answer `lt not in db`. Agents also tend to query in bursts, which public gateways throttle.

For guaranteed throughput, archive depth and a node-level mempool stream, point `TON_LITESERVERS` at a private endpoint — [tonnode.io](https://tonnode.io) provisions one in under a minute, payable in TON.

## License

MIT © [TONNode](https://tonnode.io)
