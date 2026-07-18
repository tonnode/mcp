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
| `get_swap_quote` | Firm DEX swap quote (GRAM ⇄ any jetton) via Omniston | *"How much USDT for 100 GRAM right now?"* |
| `build_swap_tx` | Unsigned, TonConnect-ready swap transaction | *"Prepare that swap for my wallet to sign"* |
| `get_crosschain_quote` | Quote TON → Ethereum/Arbitrum/Base/BNB/Polygon/Avalanche | *"How much USDT on Ethereum for my TON USDT?"* |
| `build_crosschain_swap_tx` | Unsigned HTLC escrow transaction + its secret | *"Start that cross-chain swap"* |
| `track_crosschain_swap` | Live phases of a cross-chain trade on both chains | *"Did the resolver lock my USDT on Ethereum?"* |
| `disclose_crosschain_secret` | Reveal the secret — atomically settles both sides | *"Complete the swap"* |
| `build_crosschain_refund` | Unsigned cancellation that reclaims escrowed funds | *"The trade stalled — get my money back"* |
| `generate_wallet` | Mint a fresh TON wallet (mnemonic + keys + address) | *"Create a wallet for my agent to use"* |

## Wallet generation

`generate_wallet` mints a brand-new wallet — a 24-word mnemonic, its ed25519 keypair and the address for the chosen contract version (**v4** default, plus **v3r2**, **v5r1** and **highload_v3** for mass payouts). The v3r2/v4/v5r1 addresses come from `@ton/ton`'s canonical contracts; highload_v3 is derived from the official contract code and cross-checked against a maintained reference implementation.

> ⚠️ **This returns secret key material.** In hosted mode the keys are generated on the server and returned over TLS — treat every generated wallet as **hot**: fine for programmatic/ephemeral use, but move any meaningful balance to cold storage, and keep the response out of logs and shared transcripts. The server never stores or logs the mnemonic or private key (only the public address). Operators can set `TONNODE_DISABLE_WALLET_GEN=1` to remove the tool entirely.

## Swaps — agents that can actually trade

`get_swap_quote` and `build_swap_tx` are powered by [Omniston](https://docs.ston.fi/developer-section/omniston), STON.fi's RFQ protocol aggregating STON.fi and DeDust liquidity. No API key needed.

The flow is strictly **non-custodial** — the server never sees a private key, never signs and never broadcasts:

1. `get_swap_quote` locks a firm quote (amounts in raw indivisible units; the answer includes the slippage floor, price impact, gas budget and DEX route).
2. `build_swap_tx` turns the quote into unsigned messages in exactly the shape `tonConnectUi.sendTransaction()` expects — signing and sending stay with the wallet owner.

Quotes expire in about a minute, so build promptly. Omniston emulates the transfer while building: if the wallet doesn't hold the input amount, the build fails up front instead of burning gas on-chain.

### Cross-chain

The `*_crosschain_*` tools take the same idea across blockchains: pay in GRAM or any TON jetton, receive USDT/USDC/native coins on **Ethereum, Arbitrum, Base, BNB, Polygon or Avalanche** — settled through Omniston's atomic HTLC escrow, typically in well under a minute. TON is always the source chain (the signer is a TON wallet).

The agent drives the full atomic-swap lifecycle: quote → build (the tool generates the HTLC secret and hands it to the caller — the server keeps nothing) → sign & send → track both chains → disclose the secret to settle, or build a refund if the trade stalls. At no point can the server, the resolver or anyone else redirect the funds: the secret only completes the trade as quoted, and an unfilled escrow is always reclaimable by the owner wallet.

## Hosted / self-hosted HTTP mode

The package also ships a Streamable-HTTP entry for remote deployments (this is what powers `mcp.tonnode.io`):

```bash
TONNODE_KEYS=tn_live_abc,tn_live_def PORT=8808 npx -y @tonnode/mcp --http
```

Want a ready-made hosted endpoint instead of running your own? Keys for `mcp.tonnode.io` are issued at [tonnode.io/mcp](https://tonnode.io/mcp). Clients connect without installing anything:

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
| `OMNISTON_API_URL` | Swap tools: alternative Omniston WebSocket endpoint (default `wss://omni-ws.ston.fi`) |
| `OMNISTON_INTEGRATOR_ADDRESS` / `OMNISTON_INTEGRATOR_FEE_BPS` | Swap tools: optional integrator revenue share in bps of the output — always visible to the caller as `integrator_fee_units` in every quote (default off) |
| `TONNODE_DISABLE_WALLET_GEN` | Set to `1` to remove the `generate_wallet` tool (e.g. on a shared hosted endpoint where you don't want key material generated server-side) |

### A note on public liteservers

The default public-config liteservers are shared, rate-limited and keep **no deep history** — `get_transactions` beyond recent blocks will answer `lt not in db`. Agents also tend to query in bursts, which public gateways throttle.

For guaranteed throughput, archive depth and a node-level mempool stream, point `TON_LITESERVERS` at a private endpoint — [tonnode.io](https://tonnode.io) provisions one in under a minute, payable in TON.

## License

MIT © [TONNode](https://tonnode.io)
