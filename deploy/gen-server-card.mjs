// Regenerate the static server card served at /.well-known/mcp/server-card.json
// from the actual running server, so registry metadata never drifts from code.
//   node deploy/gen-server-card.mjs > server-card.json
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";

const { version } = createRequire(import.meta.url)("../package.json");

const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"] });
const client = new Client({ name: "card-gen", version: "1.0" });
await client.connect(transport);
const { tools } = await client.listTools();
await client.close();

const card = {
  serverInfo: { name: "tonnode", version },
  authentication: { required: true, schemes: ["bearer"] },
  tools: tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
  resources: [],
  prompts: [],
};
console.log(JSON.stringify(card, null, 2));
