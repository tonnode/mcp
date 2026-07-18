// generate_wallet — mint a fresh TON wallet (mnemonic + keypair + address) for
// an agent that needs one to operate.
//
// SECURITY POSTURE. This tool creates SECRET key material and returns it to the
// caller. In hosted (HTTP) mode that material is generated in this process and
// travels back over TLS — treat every generated wallet as HOT. The server
// itself never persists or logs the mnemonic/secret (only the public address is
// logged). Operators who do not want key material flowing through a shared
// endpoint can set TONNODE_DISABLE_WALLET_GEN=1 to unregister the tool.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Address, Cell, beginCell, contractAddress } from "@ton/core";
import { mnemonicNew, mnemonicToPrivateKey } from "@ton/crypto";
import { WalletContractV3R2, WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import { ok, fail } from "./server.js";

const DISABLED = process.env.TONNODE_DISABLE_WALLET_GEN === "1";

type Version = "v3r2" | "v4" | "v5r1" | "highload_v3";

// Highload Wallet V3 is not in @ton/ton. Its address is derived from the
// official contract code (ton-blockchain/highload-wallet-contract-v3) plus a
// data cell of {publicKey, subwalletId, two empty dicts, last_clean_time=0,
// timeout}. Both the code BOC and this layout were cross-verified against the
// maintained @tonkite/highload-wallet-v3 package — the derived address matches
// byte-for-byte. Unlike seqno wallets, the highload address depends on
// subwalletId AND timeout, so they are exposed as parameters.
const HIGHLOAD_V3_CODE_HEX =
  "b5ee9c7241021001000228000114ff00f4a413f4bcf2c80b01020120020d02014803040078d020d74bc00101c060b0915be101d0d3030171b0915be0fa4030f828c705b39130e0d31f018210ae42e5a4ba9d8040d721d74cf82a01ed55fb04e030020120050a02027306070011adce76a2686b85ffc00201200809001aabb6ed44d0810122d721d70b3f0018aa3bed44d08307d721d70b1f0201200b0c001bb9a6eed44d0810162d721d70b15800e5b8bf2eda2edfb21ab09028409b0ed44d0810120d721f404f404d33fd315d1058e1bf82325a15210b99f326df82305aa0015a112b992306dde923033e2923033e25230800df40f6fa19ed021d721d70a00955f037fdb31e09130e259800df40f6fa19cd001d721d70a00937fdb31e0915be270801f6f2d48308d718d121f900ed44d0d3ffd31ff404f404d33fd315d1f82321a15220b98e12336df82324aa00a112b9926d32de58f82301de541675f910f2a106d0d31fd4d307d30cd309d33fd315d15168baf2a2515abaf2a6f8232aa15250bcf2a304f823bbf2a35304800df40f6fa199d024d721d70a00f2649130e20e01fe5309800df40f6fa18e13d05004d718d20001f264c858cf16cf8301cf168e1030c824cf40cf8384095005a1a514cf40e2f800c94039800df41704c8cbff13cb1ff40012f40012cb3f12cb15c9ed54f80f21d0d30001f265d3020171b0925f03e0fa4001d70b01c000f2a5fa4031fa0031f401fa0031fa00318060d721d300010f0020f265d2000193d431d19130e272b1fb00b585bf03";
const HIGHLOAD_DEFAULT_SUBWALLET = 0x10ad;
const HIGHLOAD_DEFAULT_TIMEOUT = 60 * 60 * 24; // 24h — matches standard tooling

function highloadAddress(workchain: number, publicKey: Buffer, subwalletId: number, timeout: number): Address {
  const code = Cell.fromBoc(Buffer.from(HIGHLOAD_V3_CODE_HEX, "hex"))[0];
  const data = beginCell()
    .storeBuffer(publicKey) // 256 bits
    .storeUint(subwalletId, 32)
    .storeUint(0, 1 + 1 + 64) // old_queries + queries (empty dicts) + last_clean_time
    .storeUint(timeout, 22)
    .endCell();
  return contractAddress(workchain, { code, data });
}

function addressFor(
  version: Version,
  workchain: number,
  publicKey: Buffer,
  subwalletId: number,
  timeout: number
): Address {
  switch (version) {
    case "v3r2":
      return WalletContractV3R2.create({ workchain, publicKey }).address;
    case "v4":
      return WalletContractV4.create({ workchain, publicKey }).address;
    case "v5r1":
      return WalletContractV5R1.create({ workchain, publicKey }).address;
    case "highload_v3":
      return highloadAddress(workchain, publicKey, subwalletId, timeout);
  }
}

export function registerWalletTools(server: McpServer): void {
  if (DISABLED) return;

  server.registerTool(
    "generate_wallet",
    {
      title: "Generate TON wallet",
      description:
        "Create a brand-new TON wallet: a fresh 24-word mnemonic, its ed25519 keypair, and the wallet address for the chosen contract version. " +
        "Use when an agent needs its own wallet to receive or send funds (e.g. before build_swap_tx). " +
        "SECURITY — READ BEFORE USE: this returns SECRET key material (mnemonic + private key). Anyone who sees this response controls the wallet and any funds in it. " +
        "In hosted mode the keys are generated on the server and returned over TLS, so treat the wallet as HOT: fine for programmatic/ephemeral use, but move any significant balance to a hardware or cold wallet, and keep this response out of logs and shared transcripts. " +
        "The server does not store or log the mnemonic or private key — only the public address. Losing the mnemonic means losing the funds; there is no recovery. " +
        "Versions: v4 (most common, recommended default), v3r2 (simple/legacy), v5r1 (W5 — gasless-capable, newest), highload_v3 (mass-payout wallet for exchanges/payment systems). " +
        "For highload_v3 the address also depends on subwallet_id and timeout_sec (they are part of the contract data), so changing them changes the address; the defaults match standard tooling — store them ALONGSIDE the mnemonic, as the mnemonic alone cannot reproduce a highload address with non-default params. " +
        "EACH CALL CREATES A NEW, INDEPENDENT WALLET — never re-call this tool to 're-read' a wallet you already made; you will get a different one and orphan any funds sent to the first. " +
        "Returns: address (recommended_deposit_address plus bounceable EQ…, non_bounceable UQ… and raw forms), public_key and private_key (hex), the 24-word mnemonic, plus version and workchain. " +
        "The address is UNINITIALIZED until the wallet is deployed by its first outgoing transaction — receiving funds does not require deployment, but the FIRST deposit must be sent to the non_bounceable (UQ…) address: a bounceable send to an undeployed wallet bounces back to the sender. Use recommended_deposit_address for incoming funds.",
      inputSchema: {
        version: z
          .enum(["v4", "v3r2", "v5r1", "highload_v3"])
          .default("v4")
          .describe("Wallet contract version: v4 (recommended), v3r2 (legacy), v5r1 (W5, newest), highload_v3 (mass payouts)"),
        workchain: z
          .number()
          .int()
          .refine((w) => w === 0 || w === -1, "workchain must be 0 (basechain) or -1 (masterchain)")
          .default(0)
          .describe("0 = basechain (normal wallets), -1 = masterchain (rarely what you want)"),
        subwallet_id: z
          .number()
          .int()
          .min(0)
          .max(0xffffffff)
          .default(HIGHLOAD_DEFAULT_SUBWALLET)
          .describe("highload_v3 only: subwallet id baked into the address (default 4269 / 0x10ad, the recommended value)"),
        timeout_sec: z
          .number()
          .int()
          .min(1)
          .max(0x3fffff)
          .default(HIGHLOAD_DEFAULT_TIMEOUT)
          .describe("highload_v3 only: message validity window in seconds, baked into the address (default 86400)"),
      },
      outputSchema: {
        version: z.string(),
        workchain: z.number(),
        recommended_deposit_address: z.string(),
        address: z.object({
          bounceable: z.string(),
          non_bounceable: z.string(),
          raw: z.string(),
        }),
        public_key: z.string(),
        private_key: z.string(),
        mnemonic: z.array(z.string()),
        subwallet_id: z.number().optional(),
        timeout_sec: z.number().optional(),
        warning: z.string(),
      },
      // NOT readOnly: although it is pure computation with no external side
      // effect, it MINTS SECRET key material and is non-idempotent (a new wallet
      // each call). readOnlyHint would tell orchestrators it is safe to auto-run
      // and re-run — neither is true for a secret-emitting generator.
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ version, workchain, subwallet_id, timeout_sec }) => {
      try {
        const isHighload = version === "highload_v3";
        const mnemonic = await mnemonicNew(); // 24 words, cryptographically secure
        const kp = await mnemonicToPrivateKey(mnemonic);
        const addr = addressFor(version as Version, workchain, kp.publicKey, subwallet_id, timeout_sec);

        // never log the secret — the address is the only thing that goes to the log
        console.error(`wallet: generated ${version} ${addr.toString({ bounceable: false })}`);

        const nonBounceable = addr.toString({ bounceable: false });
        return ok({
          version,
          workchain,
          // funding an undeployed wallet must target the non-bounceable form,
          // or a bounceable first transfer bounces back to the sender
          recommended_deposit_address: nonBounceable,
          address: {
            bounceable: addr.toString({ bounceable: true }),
            non_bounceable: nonBounceable,
            raw: addr.toRawString(),
          },
          public_key: kp.publicKey.toString("hex"),
          private_key: kp.secretKey.toString("hex"),
          mnemonic,
          ...(isHighload ? { subwallet_id, timeout_sec } : {}),
          warning:
            "SECRET — anyone with this mnemonic or private key controls the wallet. Store the mnemonic securely, keep it out of logs, and move meaningful funds to cold storage. There is no recovery if it is lost." +
            (isHighload
              ? " For highload_v3, store subwallet_id and timeout_sec together with the mnemonic — the address cannot be reproduced from the mnemonic alone."
              : "") +
            " Send the first deposit to recommended_deposit_address (non-bounceable); a bounceable transfer to this still-undeployed wallet bounces back to the sender.",
        });
      } catch (err) {
        return fail(err);
      }
    }
  );
}
