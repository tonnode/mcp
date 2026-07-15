// Programmatic use of @tonnode/mcp from Node.js — no MCP client app needed.
//
//   npm install @modelcontextprotocol/sdk
//   node node-stdio-client.mjs
//
// Spawns the server over stdio, lists its tools, then queries the balance of
// the TON Elector contract (a masterchain address that always exists).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "npx",
  args: ["-y", "@tonnode/mcp"],
  // Private endpoint (archive depth, no shared rate limits — https://tonnode.io):
  // env: { TON_LITESERVERS: '[{"ip":"1.2.3.4","port":41000,"key":"BASE64_PUBKEY"}]' },
  // Running from inside a clone of this repo? npx resolves the local package
  // instead of the published one — use { command: "node", args: ["../dist/index.js"] }.
});

const client = new Client({ name: "tonnode-example", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));

const ELECTOR = "-1:3333333333333333333333333333333333333333333333333333333333333333";
const res = await client.callTool({
  name: "get_balance",
  arguments: { address: ELECTOR },
});
console.log(JSON.parse(res.content[0].text));

await client.close();
