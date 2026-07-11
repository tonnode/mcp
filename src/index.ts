#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Address, Cell, fromNano, loadTransaction, parseTuple, serializeTuple } from "@ton/core";
import type { TupleItem } from "@ton/core";
import { getClient, withTimeout } from "./lite.js";

const server = new McpServer({ name: "tonnode", version: "0.1.0" });

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, bigintSafe, 2) }] };
}

function fail(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function bigintSafe(_key: string, value: unknown) {
  return typeof value === "bigint" ? value.toString() : value;
}

function parseAddress(raw: string): Address {
  try {
    return Address.parse(raw.trim());
  } catch {
    throw new Error(`"${raw}" is not a valid TON address (expected friendly EQ…/UQ… or raw 0:… form)`);
  }
}

const addressArg = z
  .string()
  .describe("TON address in friendly (EQ…/UQ…) or raw (0:…) form");

server.tool(
  "get_masterchain_info",
  "Current TON masterchain head: workchain, shard, seqno and block hashes. Use to check network liveness and the latest block height.",
  {},
  async () => {
    try {
      const client = await getClient();
      const info = await withTimeout(client.getMasterchainInfo());
      return ok({
        workchain: info.last.workchain,
        shard: info.last.shard,
        seqno: info.last.seqno,
        rootHash: Buffer.from(info.last.rootHash).toString("base64"),
        fileHash: Buffer.from(info.last.fileHash).toString("base64"),
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.tool(
  "get_balance",
  "TON balance of an address, in both TON and nanoTON.",
  { address: addressArg },
  async ({ address }) => {
    try {
      const client = await getClient();
      const addr = parseAddress(address);
      const master = await withTimeout(client.getMasterchainInfo());
      const state = await withTimeout(client.getAccountState(addr, master.last));
      const nano = state.balance?.coins ?? 0n;
      return ok({
        address: addr.toString(),
        balance_ton: fromNano(nano),
        balance_nano: nano,
        at_seqno: master.last.seqno,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.tool(
  "get_account_state",
  "Full account state: status (active/frozen/uninit), balance, last transaction pointer and whether code/data are deployed.",
  { address: addressArg },
  async ({ address }) => {
    try {
      const client = await getClient();
      const addr = parseAddress(address);
      const master = await withTimeout(client.getMasterchainInfo());
      const res = await withTimeout(client.getAccountState(addr, master.last));
      const storageState = res.state?.storage?.state;
      const status = storageState?.type ?? "uninit";
      return ok({
        address: addr.toString(),
        status,
        balance_ton: fromNano(res.balance?.coins ?? 0n),
        last_transaction: res.lastTx
          ? { lt: res.lastTx.lt, hash: res.lastTx.hash.toString(16) }
          : null,
        has_code: storageState?.type === "active" ? storageState.state.code !== undefined && storageState.state.code !== null : false,
        has_data: storageState?.type === "active" ? storageState.state.data !== undefined && storageState.state.data !== null : false,
        at_seqno: master.last.seqno,
      });
    } catch (err) {
      return fail(err);
    }
  }
);

server.tool(
  "get_transactions",
  "Recent transactions of an address (newest first): logical time, unix time, incoming value, outgoing message count and total fees.",
  {
    address: addressArg,
    limit: z.number().int().min(1).max(30).default(10).describe("How many transactions to return (1–30)"),
  },
  async ({ address, limit }) => {
    try {
      const client = await getClient();
      const addr = parseAddress(address);
      const master = await withTimeout(client.getMasterchainInfo());
      const state = await withTimeout(client.getAccountState(addr, master.last));
      if (!state.lastTx) return ok({ address: addr.toString(), transactions: [] });

      const hash = Buffer.from(state.lastTx.hash.toString(16).padStart(64, "0"), "hex");
      const res = await withTimeout(
        client.getAccountTransactions(addr, state.lastTx.lt.toString(), hash, limit)
      );
      const cells = Cell.fromBoc(res.transactions);
      const transactions = cells.map((cell) => {
        try {
          const tx = loadTransaction(cell.beginParse());
          const inInfo = tx.inMessage?.info;
          return {
            hash: cell.hash().toString("hex"),
            lt: tx.lt,
            unix_time: tx.now,
            in_value_ton: inInfo?.type === "internal" ? fromNano(inInfo.value.coins) : null,
            in_from: inInfo?.type === "internal" ? inInfo.src.toString() : null,
            out_messages: tx.outMessagesCount,
            total_fees_ton: fromNano(tx.totalFees.coins),
          };
        } catch {
          return { hash: cell.hash().toString("hex"), parse_error: true };
        }
      });
      return ok({ address: addr.toString(), transactions });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not in db|cannot find block/i.test(message)) {
        return fail(
          new Error(
            `${message} — the liteserver answering this query keeps no history at that depth. ` +
              `Public-config liteservers are non-archive; point TON_LITESERVERS at an archive node ` +
              `(e.g. a TONNode endpoint, https://tonnode.io) and retry.`
          )
        );
      }
      return fail(err);
    }
  }
);

server.tool(
  "run_get_method",
  "Execute a read-only get-method on a smart contract (e.g. seqno, get_wallet_address). Integer arguments only in this version.",
  {
    address: addressArg,
    method: z.string().describe("get-method name, e.g. \"seqno\""),
    args: z
      .array(z.string())
      .default([])
      .describe("Optional integer arguments, as decimal strings"),
  },
  async ({ address, method, args }) => {
    try {
      const client = await getClient();
      const addr = parseAddress(address);
      const master = await withTimeout(client.getMasterchainInfo());
      const items: TupleItem[] = args.map((v) => ({ type: "int", value: BigInt(v) }));
      const params = serializeTuple(items).toBoc();
      const res = await withTimeout(client.runMethod(addr, method, params, master.last));

      let stack: unknown[] = [];
      if (res.result) {
        const raw = typeof res.result === "string" ? Buffer.from(res.result, "base64") : res.result;
        if (raw.length > 0) {
          stack = parseTuple(Cell.fromBoc(raw)[0]).map(renderStackItem);
        }
      }
      return ok({ address: addr.toString(), method, exit_code: res.exitCode, stack });
    } catch (err) {
      return fail(err);
    }
  }
);

function renderStackItem(item: TupleItem): unknown {
  switch (item.type) {
    case "int":
      return { type: "int", value: item.value.toString() };
    case "cell":
    case "slice":
    case "builder":
      return { type: item.type, boc_base64: item.cell.toBoc().toString("base64") };
    case "null":
      return { type: "null" };
    case "nan":
      return { type: "nan" };
    case "tuple":
      return { type: "tuple", items: item.items.map(renderStackItem) };
    default:
      return { type: (item as { type: string }).type };
  }
}

await server.connect(new StdioServerTransport());

// open liteserver sockets keep the event loop alive — exit when the MCP
// client (or a closed pipe) ends stdin, so orphaned servers don't linger
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
