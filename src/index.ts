#!/usr/bin/env node
// Default: stdio MCP server for local clients (Claude, ChatGPT, Cursor, Codex…).
// With --http: hosted Streamable-HTTP mode (API keys, rate limits) — see src/http.ts.

if (process.argv.includes("--http")) {
  const { startHttp } = await import("./http.js");
  startHttp();
} else {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createTonServer } = await import("./server.js");

  await createTonServer().connect(new StdioServerTransport());

  // open liteserver sockets keep the event loop alive — exit when the MCP
  // client (or a closed pipe) ends stdin, so orphaned servers don't linger
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}
