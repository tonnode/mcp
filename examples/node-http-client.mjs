// Connect to a hosted @tonnode/mcp endpoint (Streamable HTTP) from Node.js.
//
//   npm install @modelcontextprotocol/sdk
//   MCP_URL=https://mcp.tonnode.io/mcp TONNODE_KEY=tn_live_… node node-http-client.mjs
//
// Nothing to install or run locally besides this script — the server is remote.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = process.env.MCP_URL ?? "https://mcp.tonnode.io/mcp";
const key = process.env.TONNODE_KEY ?? "tn_live_your_key";

const transport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
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
