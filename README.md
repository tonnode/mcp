# @tonnode/mcp

MCP server that gives AI agents direct **liteserver** access to [The Open Network (TON)](https://ton.org) — no HTTP gateways in the middle. Balances, account state, transaction history and contract get-methods over TON's native ADNL protocol.

Built by [TONNode](https://tonnode.io) — private TON liteservers, archive nodes, mempool stream and indexed API.

## Quick start

Add to Claude Desktop, Claude Code, Cursor or any MCP client:

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

That's the whole integration. The server connects to TON mainnet via the public global config by default.

## Tools

| Tool | What it does |
|---|---|
| `get_masterchain_info` | Current masterchain head: seqno, shard, block hashes |
| `get_balance` | TON balance of an address (TON + nanoTON) |
| `get_account_state` | Status (active/frozen/uninit), balance, last-tx pointer, code/data flags |
| `get_transactions` | Recent transactions: lt, time, incoming value, fees |
| `run_get_method` | Read-only get-methods on contracts (`seqno`, `get_wallet_address`, …) |

## Configuration

| Env var | Meaning |
|---|---|
| `TON_LITESERVERS` | Use your own liteservers instead of the public config: `[{"ip":"1.2.3.4","port":40004,"key":"<base64 ed25519>"}]` |
| `TON_CONFIG_URL` | Alternative global-config URL |
| `TON_NETWORK=testnet` | Use the testnet config (or pass `--testnet`) |

### A note on public liteservers

The default public-config liteservers are shared, rate-limited and keep **no deep history** — `get_transactions` beyond recent blocks will answer `lt not in db`. Agents also tend to query in bursts, which public gateways throttle.

For guaranteed throughput, archive depth and a node-level mempool stream, point `TON_LITESERVERS` at a private endpoint — [tonnode.io](https://tonnode.io) provisions one in under a minute, payable in TON.

## License

MIT © [TONNode](https://tonnode.io)
