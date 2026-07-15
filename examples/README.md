# Examples

Ready-to-copy configs for every major MCP client, plus programmatic usage from Node.js.

Русская версия документации: [README.ru.md](../README.ru.md)

## Client configs

| File | Client | Where it goes |
|---|---|---|
| [claude-desktop.json](claude-desktop.json) | Claude Desktop | `claude_desktop_config.json` (Settings → Developer) |
| [claude-code.mcp.json](claude-code.mcp.json) | Claude Code | `.mcp.json` in your project root — or run `claude mcp add ton -- npx -y @tonnode/mcp` |
| [cursor.json](cursor.json) | Cursor | `~/.cursor/mcp.json` |
| [codex.toml](codex.toml) | OpenAI Codex CLI | merge into `~/.codex/config.toml` |
| [vscode.json](vscode.json) | VS Code | `.vscode/mcp.json` |

## Endpoint variants

| File | What it shows |
|---|---|
| [private-liteserver.json](private-liteserver.json) | Point the server at your own liteserver (`TON_LITESERVERS`) — archive depth, no shared rate limits |
| [hosted-http.json](hosted-http.json) | Connect to a hosted endpoint (e.g. `mcp.tonnode.io`) — no local install at all |

## Programmatic use (Node.js)

| File | What it shows |
|---|---|
| [node-stdio-client.mjs](node-stdio-client.mjs) | Spawn the server locally over stdio, list tools, query the Elector contract balance |
| [node-http-client.mjs](node-http-client.mjs) | Same against a hosted Streamable-HTTP endpoint with a Bearer key |

Run them with Node.js ≥ 18:

```bash
npm install @modelcontextprotocol/sdk
node node-stdio-client.mjs
MCP_URL=https://mcp.tonnode.io/mcp TONNODE_KEY=tn_live_… node node-http-client.mjs
```
