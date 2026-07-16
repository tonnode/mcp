import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Address, beginCell, Cell, fromNano, loadTransaction, parseTuple, serializeTuple } from "@ton/core";
import type { TupleItem } from "@ton/core";
import { getClient, withTimeout } from "./lite.js";

function ok(data: unknown) {
  // strip bigints once; the same plain object feeds both the text block and structuredContent
  const plain = JSON.parse(JSON.stringify(data, bigintSafe)) as Record<string, unknown>;
  return {
    content: [{ type: "text" as const, text: JSON.stringify(plain, null, 2) }],
    structuredContent: plain,
  };
}

/** every tool is a pure read — declare it so agents and gateways can plan safely */
const READ_ONLY = { readOnlyHint: true, idempotentHint: true, openWorldHint: true };

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

const addressArg = z
  .string()
  .describe("TON address in friendly (EQ…/UQ…) or raw (0:… / -1:…) form");

export function createTonServer(): McpServer {
  const server = new McpServer({ name: "tonnode", version: "0.5.0" });

  server.registerTool(
    "get_masterchain_info",
    {
      title: "Masterchain info",
      description:
        "Latest TON masterchain block: workchain, shard, seqno and block hashes. " +
        "Use when: checking that the network (or your endpoint) is alive and synced, or when you need the current block height. " +
        "Returns: workchain, shard, seqno, rootHash/fileHash in base64. " +
        "Tip: masterchain produces a block roughly every 3 seconds — if seqno does not grow between calls, the liteserver is lagging.",
      inputSchema: {},
      outputSchema: {
        workchain: z.number(),
        shard: z.string(),
        seqno: z.number(),
        rootHash: z.string(),
        fileHash: z.string(),
      },
      annotations: READ_ONLY,
    },
    async () => {
      try {
        const client = await getClient();
        const info = await withTimeout(client.getMasterchainInfo());
        return ok({
          workchain: info.last.workchain,
          shard: String(info.last.shard),
          seqno: info.last.seqno,
          rootHash: Buffer.from(info.last.rootHash).toString("base64"),
          fileHash: Buffer.from(info.last.fileHash).toString("base64"),
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "get_balance",
    {
      title: "GRAM balance",
      description:
        "Native GRAM coin balance of a TON address (GRAM is the renamed Toncoin; the network is still called TON). " +
        "Use when: the question is about the native coin only. For token balances (USDT and other jettons) use get_jetton_balance; " +
        "for deployment status, code flags and the last transaction use get_account_state. " +
        "Returns: balance_gram (decimal string, e.g. \"12.5\"), balance_nano (string, 1 GRAM = 1e9 nano) and at_seqno — the masterchain block the reading is anchored to. " +
        "Never-funded (uninitialized) addresses return 0 — that is not an error.",
      inputSchema: { address: addressArg },
      outputSchema: {
        address: z.string(),
        balance_gram: z.string(),
        balance_nano: z.string(),
        at_seqno: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ address }) => {
      try {
        const client = await getClient();
        const addr = parseAddress(address);
        const master = await withTimeout(client.getMasterchainInfo());
        const state = await withTimeout(client.getAccountState(addr, master.last));
        const nano = state.balance?.coins ?? 0n;
        return ok({
          address: addr.toString(),
          balance_gram: fromNano(nano),
          balance_nano: nano.toString(),
          at_seqno: master.last.seqno,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "get_account_state",
    {
      title: "Account state",
      description:
        "Full account state of a TON address: status (active / frozen / uninit), GRAM balance, last-transaction pointer (lt + hash) and whether contract code/data are deployed. " +
        "Use when: checking if a contract or wallet is deployed, diagnosing why an address does not respond, or before run_get_method (which needs status=active). " +
        "Returns: status, balance_gram, last_transaction {lt (string), hash — 64-char hex}, has_code, has_data, at_seqno. " +
        "Reading the result: status=uninit with a non-zero balance means funds arrived but the wallet contract is not deployed yet; " +
        "the last_transaction pointer is the cursor get_transactions starts from.",
      inputSchema: { address: addressArg },
      outputSchema: {
        address: z.string(),
        status: z.string(),
        balance_gram: z.string(),
        last_transaction: z.object({ lt: z.string(), hash: z.string() }).nullable(),
        has_code: z.boolean(),
        has_data: z.boolean(),
        at_seqno: z.number(),
      },
      annotations: READ_ONLY,
    },
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
          balance_gram: fromNano(res.balance?.coins ?? 0n),
          last_transaction: res.lastTx
            ? { lt: String(res.lastTx.lt), hash: res.lastTx.hash.toString(16).padStart(64, "0") }
            : null,
          has_code:
            storageState?.type === "active"
              ? storageState.state.code !== undefined && storageState.state.code !== null
              : false,
          has_data:
            storageState?.type === "active"
              ? storageState.state.data !== undefined && storageState.state.data !== null
              : false,
          at_seqno: master.last.seqno,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "get_transactions",
    {
      title: "Recent transactions",
      description:
        "Recent transactions of a TON address, newest first. " +
        "Use when: verifying that a payment arrived, listing latest wallet activity, or tracing what an address did recently. " +
        "Returns an array of {hash, lt (string), unix_time, in_value_gram, in_from, out_messages, total_fees_gram} — " +
        "in_value_gram/in_from describe the incoming message (null for outgoing-only transactions). " +
        "Never-active addresses return an empty array (not an error); an undecodable transaction comes back as {hash, parse_error: true}. " +
        "No pagination: each call reads from the account's newest transaction — at most the 30 most recent are reachable. " +
        "History depth: an error like \"lt not in db\" means this liteserver has already pruned that part of history — " +
        "only archive endpoints keep the full chain; retry through one (TON_LITESERVERS or a TONNode hosted key) for deep history.",
      inputSchema: {
        address: addressArg,
        limit: z.number().int().min(1).max(30).default(10).describe("How many transactions to return, 1–30 (default 10)"),
      },
      outputSchema: {
        address: z.string(),
        transactions: z.array(
          z.object({
            hash: z.string(),
            lt: z.string().optional(),
            unix_time: z.number().optional(),
            in_value_gram: z.string().nullable().optional(),
            in_from: z.string().nullable().optional(),
            out_messages: z.number().optional(),
            total_fees_gram: z.string().optional(),
            parse_error: z.boolean().optional(),
          })
        ),
      },
      annotations: READ_ONLY,
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
              lt: tx.lt.toString(),
              unix_time: tx.now,
              in_value_gram: inInfo?.type === "internal" ? fromNano(inInfo.value.coins) : null,
              in_from: inInfo?.type === "internal" ? inInfo.src.toString() : null,
              out_messages: tx.outMessagesCount,
              total_fees_gram: fromNano(tx.totalFees.coins),
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

  server.registerTool(
    "run_get_method",
    {
      title: "Run get-method",
      description:
        "Execute a read-only get-method (no gas, no state change) on a smart contract: seqno, get_jetton_data, get_sale_data, get_collection_data and anything else the contract exposes. " +
        "Use when: reading typed on-chain data from a specific contract. The contract must be active — check with get_account_state first if unsure. " +
        "Args: only integer arguments are supported here (decimal strings); methods that need an address/slice argument have dedicated tools — " +
        "e.g. use get_jetton_balance instead of calling get_wallet_address manually. " +
        "Returns: exit_code (0 or 1 = success; 11 usually means the contract has no such method; other values are contract-specific errors) and the result stack — " +
        "typed items like {type:\"int\", value} or {type:\"cell\"|\"slice\", boc_base64}.",
      inputSchema: {
        address: addressArg,
        method: z.string().describe('get-method name, e.g. "seqno" or "get_jetton_data"'),
        args: z
          .array(z.string())
          .default([])
          .describe('Integer arguments as decimal strings, e.g. ["0"] (most methods take none)'),
      },
      outputSchema: {
        address: z.string(),
        method: z.string(),
        exit_code: z.number(),
        stack: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: READ_ONLY,
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

  server.registerTool(
    "get_jetton_balance",
    {
      title: "Jetton balance",
      description:
        "Jetton (TON token) balance of an owner address — USDT and every other TEP-74 token. " +
        "Use when: the question is about token balances rather than the native GRAM coin (for GRAM use get_balance). " +
        "Args: owner — the holder's address; jetton_master — the token's master contract address. " +
        "How it works: derives the owner's jetton-wallet address from the master, then reads its balance on-chain. " +
        "Returns: jetton_wallet (the derived address), balance in raw indivisible units (string), deployed — " +
        "false means the owner never held this token, so the balance is 0 — and at_seqno. " +
        "Raw units: divide by 10^decimals; USDT uses 6 decimals, most other jettons 9 " +
        "(read decimals from the master's metadata via run_get_method get_jetton_data).",
      inputSchema: {
        owner: z.string().describe("Holder's TON address, friendly (EQ…/UQ…) or raw (0:… / -1:…) form"),
        jetton_master: z
          .string()
          .describe('Jetton master contract address, e.g. USDT "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"'),
      },
      outputSchema: {
        owner: z.string(),
        jetton_master: z.string(),
        jetton_wallet: z.string(),
        balance: z.string(),
        deployed: z.boolean(),
        at_seqno: z.number(),
      },
      annotations: READ_ONLY,
    },
    async ({ owner, jetton_master }) => {
      try {
        const client = await getClient();
        const ownerAddr = parseAddress(owner);
        const masterAddr = parseAddress(jetton_master);
        const master = await withTimeout(client.getMasterchainInfo());

        // jetton master derives the per-owner wallet address: get_wallet_address(slice owner)
        const ownerSlice = beginCell().storeAddress(ownerAddr).endCell();
        const params = serializeTuple([{ type: "slice", cell: ownerSlice }]).toBoc();
        const res = await withTimeout(client.runMethod(masterAddr, "get_wallet_address", params, master.last));
        if (res.exitCode !== 0 && res.exitCode !== 1) {
          throw new Error(
            `get_wallet_address failed with exit code ${res.exitCode} — is ${masterAddr.toString()} really a jetton master?`
          );
        }
        const raw = typeof res.result === "string" ? Buffer.from(res.result, "base64") : res.result;
        const stack = parseTuple(Cell.fromBoc(raw!)[0]);
        const first = stack[0];
        if (!first || (first.type !== "slice" && first.type !== "cell")) {
          throw new Error("unexpected get_wallet_address result — no address in the stack");
        }
        const jettonWallet = first.cell.beginParse().loadAddress();

        // the wallet may not exist yet — that simply means a zero balance
        let balance = "0";
        let deployed = false;
        try {
          const data = await withTimeout(
            client.runMethod(jettonWallet, "get_wallet_data", serializeTuple([]).toBoc(), master.last)
          );
          if (data.exitCode === 0 || data.exitCode === 1) {
            const dataRaw = typeof data.result === "string" ? Buffer.from(data.result, "base64") : data.result;
            const dataStack = parseTuple(Cell.fromBoc(dataRaw!)[0]);
            if (dataStack[0]?.type === "int") {
              balance = dataStack[0].value.toString();
              deployed = true;
            }
          }
        } catch {
          // uninitialized jetton wallet — the owner never received this token
        }

        return ok({
          owner: ownerAddr.toString(),
          jetton_master: masterAddr.toString(),
          jetton_wallet: jettonWallet.toString(),
          balance,
          deployed,
          at_seqno: master.last.seqno,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  server.registerTool(
    "parse_address",
    {
      title: "Parse address",
      description:
        "Parse, validate and convert a TON address between all its formats — purely local, no network access. " +
        "Use when: normalizing user input, comparing addresses that look different but may be the same account, " +
        "or converting to the raw form that indexers and APIs expect. " +
        "Accepts friendly (EQ…/UQ…, with or without URL-safe characters) and raw (workchain:hex) forms. " +
        "Returns: raw, friendly_bounceable (EQ…), friendly_non_bounceable (UQ…), workchain and flags of the given input. " +
        "Background: EQ… and UQ… encode the SAME account — EQ (bounceable) is conventional for contracts, " +
        "UQ (non-bounceable) for user wallets; two addresses are equal if their raw forms match.",
      inputSchema: {
        address: z.string().describe("TON address in any form: friendly (EQ…/UQ…) or raw (0:… / -1:…)"),
      },
      outputSchema: {
        raw: z.string(),
        friendly_bounceable: z.string(),
        friendly_non_bounceable: z.string(),
        workchain: z.number(),
        input_format: z.enum(["friendly", "raw"]),
        input_flags: z.object({ bounceable: z.boolean(), test_only: z.boolean() }).nullable(),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ address }) => {
      try {
        const trimmed = address.trim();
        const addr = parseAddress(trimmed);
        let input_format: "friendly" | "raw" = "raw";
        let input_flags: { bounceable: boolean; test_only: boolean } | null = null;
        try {
          const friendly = Address.parseFriendly(trimmed);
          input_format = "friendly";
          input_flags = { bounceable: friendly.isBounceable, test_only: friendly.isTestOnly };
        } catch {
          // raw form
        }
        return ok({
          raw: addr.toRawString(),
          friendly_bounceable: addr.toString({ bounceable: true }),
          friendly_non_bounceable: addr.toString({ bounceable: false }),
          workchain: addr.workChain,
          input_format,
          input_flags,
        });
      } catch (err) {
        return fail(err);
      }
    }
  );

  return server;
}
