import { ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import axios from "axios";
import { getConfig, resolveFunder } from "../config.js";
import { logger } from "../logger.js";

// Polymarket's CLOB sits behind Cloudflare, which 403s the SDK's default
// `@polymarket/clob-client` User-Agent on auth endpoints. Override globally.
axios.defaults.headers.common["User-Agent"] =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

let _client: ClobClient | null = null;
let _walletAddress: `0x${string}` | null = null;

/** Build (or return cached) signed CLOB client with derived L2 API credentials. */
export async function getClobClient(): Promise<{ client: ClobClient; address: `0x${string}` }> {
  if (_client && _walletAddress) return { client: _client, address: _walletAddress };

  const cfg = getConfig();
  const account = privateKeyToAccount(cfg.PRIVATE_KEY as `0x${string}`);
  _walletAddress = account.address;

  const signer = createWalletClient({ account, chain: polygon, transport: http() });

  // 1. Temp client for L1-only auth (sufficient to derive L2 creds).
  const tempClient = new ClobClient({
    host: cfg.CLOB_HOST,
    chain: cfg.CHAIN_ID,
    signer,
  });

  logger.info({ wallet: account.address }, "Deriving L2 API credentials");
  const creds = await tempClient.createOrDeriveApiKey();

  _client = new ClobClient({
    host: cfg.CLOB_HOST,
    chain: cfg.CHAIN_ID,
    signer,
    creds,
    signatureType: cfg.SIGNATURE_TYPE,
    funderAddress: resolveFunder(cfg, account.address),
  });

  logger.info({ apiKey: creds.key }, "CLOB client ready");
  return { client: _client, address: _walletAddress };
}

/** Surface L2 creds for user-WS subscription. */
export async function getL2Creds(): Promise<{ apiKey: string; secret: string; passphrase: string }> {
  const { client } = await getClobClient();
  // The client stores creds privately; pull them off via createOrDeriveApiKey
  // (idempotent — returns the existing key if one was already derived).
  const cfg = getConfig();
  const account = privateKeyToAccount(cfg.PRIVATE_KEY as `0x${string}`);
  const signer = createWalletClient({ account, chain: polygon, transport: http() });
  const tmp = new ClobClient({ host: cfg.CLOB_HOST, chain: cfg.CHAIN_ID, signer });
  const creds = await tmp.createOrDeriveApiKey();
  void client;
  return { apiKey: creds.key, secret: creds.secret, passphrase: creds.passphrase };
}
