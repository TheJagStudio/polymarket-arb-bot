import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  // Polymarket wallet
  PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/, "PRIVATE_KEY must be 0x + 64 hex"),
  WALLET_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  SIGNATURE_TYPE: z.coerce.number().int().min(0).max(2).default(0),
  FUNDER_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional().or(z.literal("")),

  // Endpoints
  CLOB_HOST: z.string().url().default("https://clob.polymarket.com"),
  GAMMA_HOST: z.string().url().default("https://gamma-api.polymarket.com"),
  DATA_API_HOST: z.string().url().default("https://data-api.polymarket.com"),
  MARKET_WS_URL: z.string().url().default("wss://ws-subscriptions-clob.polymarket.com/ws/market"),
  USER_WS_URL: z.string().url().default("wss://ws-subscriptions-clob.polymarket.com/ws/user"),
  CHAIN_ID: z.coerce.number().int().default(137),

  // Postgres
  POSTGRES_URL: z.string().url(),
  POSTGRES_URL_NON_POOLING: z.string().url(),

  // Strategy
  ARB_THRESHOLD: z.coerce.number().min(0.5).max(0.999).default(0.97),
  SHARES_PER_LEG: z.coerce.number().min(5).default(10),
  MAX_DAILY_TRADES: z.coerce.number().int().default(20),
  MAX_OPEN_EXPOSURE_USD: z.coerce.number().default(200),
  WINDOW_MINUTES: z
    .string()
    .default("5,15")
    .transform((s) => s.split(",").map((x) => Number(x.trim())).filter((n) => !Number.isNaN(n))),

  // Runtime
  DRY_RUN: z
    .string()
    .default("true")
    .transform((s) => s.toLowerCase() === "true" || s === "1"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Config = z.infer<typeof schema>;

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("❌ Invalid environment configuration:");
    console.error(parsed.error.format());
    process.exit(1);
  }
  _config = parsed.data;
  return _config;
}

/** Funder address used by the CLOB client. For EOA (sigtype 0) this is the wallet itself. */
export function resolveFunder(cfg: Config, walletAddress: string): string {
  if (cfg.SIGNATURE_TYPE === 0) return walletAddress;
  if (!cfg.FUNDER_ADDRESS) {
    throw new Error("FUNDER_ADDRESS is required when SIGNATURE_TYPE != 0");
  }
  return cfg.FUNDER_ADDRESS;
}
