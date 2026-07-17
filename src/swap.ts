// Intrachain jetton/GRAM swaps via Omniston (STON.fi's RFQ aggregation).
//
// Strictly non-custodial: get_swap_quote fetches a firm quote, build_swap_tx
// turns it into UNSIGNED TonConnect-ready messages. No key material ever
// touches this server — signing and sending stay with the wallet owner.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { fail, ok, parseAddress } from "./server.js";
import {
  BUILD_TIMEOUT_MS,
  TESTNET_BLOCKED,
  TESTNET_ERROR,
  describeError,
  firstQuote,
  integratorParams,
  parseTonAsset,
  parseUnits,
  renderAsset,
  toTonconnect,
  withDeadline,
  withOmniston,
} from "./omniston.js";

const assetArg = z
  .string()
  .describe('"GRAM" for the native coin, or a jetton master address (e.g. USDT "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs")');

export function registerSwapTools(server: McpServer): void {
  server.registerTool(
    "get_swap_quote",
    {
      title: "Swap quote",
      description:
        "Firm swap quote for exchanging GRAM or any jetton into another asset on TON, via the Omniston protocol (STON.fi RFQ aggregation over STON.fi/DeDust liquidity). MAINNET only. " +
        "Use when: an agent wants to know the current exchange terms, or as step 1 of an actual swap (step 2 is build_swap_tx with the returned quote_id). " +
        "For swaps INTO another blockchain (ETH, Base, BNB…) use get_crosschain_quote instead. " +
        "Amounts are raw indivisible units — GRAM has 9 decimals (1 GRAM = 1e9), USDT has 6; read a jetton's decimals via run_get_method get_jetton_data if unsure. " +
        "Returns: quote_id (pass it to build_swap_tx PROMPTLY — quotes expire in about a minute), input/output amounts, " +
        "min_output_units (the on-chain slippage floor the swap will be built with — the only guaranteed minimum), price_impact_bps, " +
        "integrator_fee_units (revenue share of the server operator, if configured — already deducted from output_units), " +
        "gas_budget_nano (GRAM the wallet must additionally hold for gas) and the DEX route. " +
        "This is a price lookup only — nothing is signed or sent.",
      inputSchema: {
        from_asset: assetArg,
        to_asset: assetArg,
        amount_units: z
          .string()
          .describe('Amount in raw indivisible units of the "exact" side, e.g. "1000000000" = 1 GRAM'),
        exact: z
          .enum(["input", "output"])
          .default("input")
          .describe(
            "Which side amount_units fixes: input = spend exactly this much; output = target receiving this much after fees " +
              "(the guaranteed on-chain floor is still min_output_units — top up amount_units or tighten slippage_bps when an exact minimum must clear)"
          ),
        slippage_bps: z
          .number()
          .int()
          .min(1)
          .max(500)
          .default(500)
          .describe(
            "Max price slippage in basis points (1 bps = 0.01%), 1–500, default 500 = 5%. " +
              "Tighten for stronger price protection — below the floor the swap refunds instead of executing; the 5% cap is deliberate, more only feeds MEV"
          ),
      },
      outputSchema: {
        quote_id: z.string(),
        resolver: z.string(),
        input_asset: z.string(),
        output_asset: z.string(),
        input_units: z.string(),
        output_units: z.string(),
        min_output_units: z.string(),
        recommended_min_output_units: z.string(),
        recommended_slippage_bps: z.number(),
        price_impact_bps: z.number().nullable(),
        protocol_fee_units: z.string(),
        integrator_fee_units: z.string(),
        gas_budget_nano: z.string().nullable(),
        estimated_settlement_seconds: z.number().nullable(),
        route: z.array(
          z.object({
            from: z.string(),
            to: z.string(),
            protocols: z.array(z.string()),
          })
        ),
      },
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ from_asset, to_asset, amount_units, exact, slippage_bps }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const inputAsset = parseTonAsset(from_asset);
        const outputAsset = parseTonAsset(to_asset);
        if (renderAsset(inputAsset) === renderAsset(outputAsset)) {
          throw new Error("from_asset and to_asset are the same asset");
        }
        const units = parseUnits(amount_units, "amount_units");

        const quote = await withOmniston((omni) =>
          firstQuote(omni, {
            inputAsset,
            outputAsset,
            amount:
              exact === "output"
                ? { $case: "outputUnits", value: units }
                : { $case: "inputUnits", value: units },
            settlementParams: [
              { params: { $case: "swap", value: { maxPriceSlippagePips: slippage_bps * 100 } } },
            ],
            ...integratorParams(),
          })
        );

        const swap = quote.settlementData?.$case === "swap" ? quote.settlementData.value : null;
        if (!swap) throw new Error(`unexpected settlement type "${quote.settlementData?.$case}" — expected swap`);

        return ok({
          quote_id: quote.quoteId,
          resolver: quote.resolverName,
          input_asset: renderAsset(quote.inputAsset as never),
          output_asset: renderAsset(quote.outputAsset as never),
          input_units: quote.inputUnits,
          output_units: quote.outputUnits,
          min_output_units: swap.minOutputAmount,
          recommended_min_output_units: swap.recommendedMinOutputAmount,
          recommended_slippage_bps: Math.round(swap.recommendedSlippagePips / 100),
          price_impact_bps:
            swap.priceImpactPips !== undefined ? Math.round(swap.priceImpactPips / 100) : null,
          protocol_fee_units: quote.protocolFeeUnits,
          integrator_fee_units: quote.integratorFeeUnits,
          gas_budget_nano: quote.gasBudget ?? null,
          estimated_settlement_seconds: quote.estimatedSettlementDuration ?? null,
          route: swap.routes.flatMap((r) =>
            r.steps.map((s) => ({
              from: renderAsset(s.inputAsset as never),
              to: renderAsset(s.outputAsset as never),
              protocols: [...new Set(s.chunks.map((c) => c.protocol))],
            }))
          ),
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );

  server.registerTool(
    "build_swap_tx",
    {
      title: "Build swap transaction",
      description:
        "Build the UNSIGNED transaction for a swap quoted by get_swap_quote. Non-custodial: this returns TonConnect-ready messages — " +
        "nothing is signed and nothing is sent; the wallet owner signs and broadcasts them (e.g. tonConnectUi.sendTransaction(result.tonconnect)). " +
        "The messages MOVE REAL FUNDS once signed, so treat the output as an armed payment and show it to the wallet owner before sending. " +
        "Use when: an agent (or the app driving it) actually wants to execute the swap after inspecting the quote. " +
        "Args: quote_id from get_swap_quote (use it promptly — expired quotes fail and need a re-quote) and wallet — the address that will send the transaction, " +
        "receive the swap output and any gas excess. " +
        "Returns: tonconnect {validUntil, network, messages[{address, amount, payload, stateInit?}]} with base64 BoC payloads, exactly the shape TonConnect sendTransaction expects. " +
        "Omniston emulates the transfer while building — if the wallet lacks the input funds, this fails up front. " +
        "The wallet must hold the input amount (for GRAM swaps it is included in the attached value) plus the quote's gas_budget_nano in GRAM.",
      inputSchema: {
        quote_id: z.string().describe("Quote id returned by get_swap_quote"),
        wallet: z
          .string()
          .describe("TON address that will sign and send the swap (also receives output and gas excess)"),
        use_recommended_slippage: z
          .boolean()
          .default(false)
          .describe(
            "true = build with Omniston's recommended slippage floor (recommended_min_output_units) instead of the floor from your quote request — it can be LOOSER than what you asked for"
          ),
      },
      outputSchema: {
        quote_id: z.string(),
        wallet: z.string(),
        message_count: z.number(),
        total_attached_nano: z.string(),
        tonconnect: z.object({
          validUntil: z.number(),
          network: z.string(),
          messages: z.array(
            z.object({
              address: z.string(),
              amount: z.string(),
              payload: z.string(),
              stateInit: z.string().optional(),
            })
          ),
        }),
      },
      // not readOnly: the output is an armed, fund-moving artifact — clients
      // that auto-approve read-only tools must still gate this one
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ quote_id, wallet, use_recommended_slippage }) => {
      try {
        if (TESTNET_BLOCKED) throw new Error(TESTNET_ERROR);
        const addr = parseAddress(wallet);
        const id = quote_id.trim();
        if (!/^[0-9a-f]{64}$/i.test(id)) {
          throw new Error("quote_id must be the 64-char hex id returned by get_swap_quote");
        }

        const tx = await withOmniston((omni) =>
          withDeadline(
            omni.tonBuildSwap({
              quoteId: id,
              transferSrcAddress: { chain: { $case: "ton", value: addr.toString() } },
              useRecommendedSlippage: use_recommended_slippage,
            }),
            BUILD_TIMEOUT_MS,
            "building the swap transaction"
          )
        );

        if (!tx.messages.length) throw new Error("Omniston returned no messages for this quote");

        return ok({
          quote_id: id,
          wallet: addr.toString({ bounceable: false }),
          message_count: tx.messages.length,
          ...toTonconnect(tx.messages),
        });
      } catch (err) {
        return fail(describeError(err));
      }
    }
  );
}
