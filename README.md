# @tonnode/mcp

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

| Tool | What it does |
|---|---|
| `get_masterchain_info` | Current masterchain head: seqno, shard, block hashes |
| `get_balance` | GRAM balance of an address (GRAM + nano) |
| `get_account_state` | Status (active/frozen/uninit), balance, last-tx pointer, code/data flags |
| `get_transactions` | Recent transactions: lt, time, incoming value, fees |
| `run_get_method` | Read-only get-methods on contracts (`seqno`, `get_wallet_address`, …) |

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

Requests are authenticated with Bearer keys from `TONNODE_KEYS` (comma-separated) and rate-limited per key (`RATE_LIMIT_RPM`, default 300). Sessions are private to the key that opened them, idle sessions are swept after `SESSION_TTL_MIN` (default 30 minutes), and concurrent sessions are capped per key and globally. Without `TONNODE_KEYS` the server refuses to start; set `TONNODE_ALLOW_OPEN=1` to explicitly run keyless behind your own firewall. `GET /healthz` for monitoring.

The server binds `127.0.0.1` by default — put a TLS reverse proxy (Caddy, nginx) in front and set `HOST=0.0.0.0` only if the proxy runs on another machine. Ready-made systemd + Caddy configs live in [`deploy/`](deploy/).

## Configuration

| Env var | Meaning |
|---|---|
| `TON_LITESERVERS` | Use your own liteservers instead of the public config: `[{"ip":"1.2.3.4","port":40004,"key":"<base64 ed25519>"}]` |
| `TON_CONFIG_URL` | Alternative global-config URL |
| `TON_NETWORK=testnet` | Use the testnet config (or pass `--testnet`) |
| `TONNODE_KEYS` | HTTP mode: comma-separated Bearer API keys |
| `HOST` | HTTP mode: bind address (default `127.0.0.1`) |
| `PORT` | HTTP mode: listen port (default 8808) |
| `RATE_LIMIT_RPM` | HTTP mode: requests per minute per key (default 300) |
| `SESSION_TTL_MIN` | HTTP mode: idle minutes before a session is swept (default 30) |
| `MAX_SESSIONS` / `MAX_SESSIONS_PER_KEY` | HTTP mode: concurrent session caps (default 500 / 50) |

### A note on public liteservers

The default public-config liteservers are shared, rate-limited and keep **no deep history** — `get_transactions` beyond recent blocks will answer `lt not in db`. Agents also tend to query in bursts, which public gateways throttle.

For guaranteed throughput, archive depth and a node-level mempool stream, point `TON_LITESERVERS` at a private endpoint — [tonnode.io](https://tonnode.io) provisions one in under a minute, payable in TON.

## License

MIT © [TONNode](https://tonnode.io)
