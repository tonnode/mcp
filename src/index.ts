#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTonServer } from "./server.js";

await createTonServer().connect(new StdioServerTransport());

// open liteserver sockets keep the event loop alive — exit when the MCP
// client (or a closed pipe) ends stdin, so orphaned servers don't linger
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
