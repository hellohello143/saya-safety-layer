// Centralised, validated environment config. Everything reads from here so a
// missing/typo'd env var fails fast at boot with a clear message.
//
// Two chains can run at once:
//   EVM_NETWORK   : base-sepolia (default) | base            (NETWORK is a legacy alias)
//   SOLANA_NETWORK: off (default) | solana-devnet | solana
// USDC/RPC resolve from each selection. EVM stays always-available (its network is
// always a valid id); Solana is opt-in (SOLANA_ENABLED). REAL money on base/solana.

import 'dotenv/config';
import { z } from 'zod';
import {
  EVM_NETWORKS,
  SOLANA_NETWORKS,
  type EvmNetworkId,
  type SolanaNetworkId,
} from './network.js';

const EnvSchema = z
  .object({
    CDP_API_KEY_ID: z.string().min(1),
    CDP_API_KEY_SECRET: z.string().min(1),
    CDP_WALLET_SECRET: z.string().min(1),

    // networks (NETWORK kept as backward-compat alias for EVM_NETWORK)
    EVM_NETWORK: z.enum(['base', 'base-sepolia']).optional(),
    NETWORK: z.enum(['base', 'base-sepolia']).optional(),
    SOLANA_NETWORK: z.enum(['solana', 'solana-devnet', 'off']).default('off'),

    // EVM account names
    CDP_OWNER_ACCOUNT_NAME: z.string().default('safety-owner'),
    CDP_SMART_ACCOUNT_NAME: z.string().default('safety-treasury'),
    CDP_SPENDER_ACCOUNT_NAME: z.string().default('safety-spender'),
    // Solana account names
    CDP_SOLANA_TREASURY_ACCOUNT_NAME: z.string().default('safety-treasury-sol'),
    CDP_SOLANA_SPENDER_ACCOUNT_NAME: z.string().default('safety-spender-sol'),

    // optional overrides (resolved from the selected network otherwise)
    USDC_ADDRESS: z.string().optional(), // EVM
    RPC_URL: z.string().url().optional(), // EVM
    SOLANA_USDC_MINT: z.string().optional(),
    SOLANA_RPC_URL: z.string().url().optional(),
    SPEND_PERMISSION_MANAGER_ADDRESS: z
      .string()
      .default('0xf85210B21cC50302F477BA56686d2019dC9b67Ad'),

    // server
    PORT: z.coerce.number().int().positive().default(3000),
    HOST: z.string().default('127.0.0.1'),
    // Bearer token protecting all /api/* routes. If unset, auth is disabled (local
    // dev only) — the server REFUSES to start on any mainnet without it.
    API_TOKEN: z.string().optional(),

    // database
    DATABASE_URL: z.string().default('./data/safety-layer.db'),

    // circuit breaker
    CIRCUIT_BREAKER_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
    CIRCUIT_BREAKER_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),

    // mock seller
    MOCK_SELLER_PORT: z.coerce.number().int().positive().default(4021),
    MOCK_SELLER_PAY_TO: z.string().optional(), // EVM merchant address
    MOCK_SELLER_PAY_TO_SOLANA: z.string().optional(), // Solana merchant address
    MOCK_SELLER_PRICE_USDC: z.string().default('0.01'),
  })
  .transform((e) => {
    const evmId = (e.EVM_NETWORK ?? e.NETWORK ?? 'base-sepolia') as EvmNetworkId;
    const evm = EVM_NETWORKS[evmId];
    const solEnabled = e.SOLANA_NETWORK !== 'off';
    const solId = solEnabled ? (e.SOLANA_NETWORK as SolanaNetworkId) : null;
    const sol = solId ? SOLANA_NETWORKS[solId] : null;
    return {
      ...e,
      // EVM (existing code reads NETWORK / USDC_ADDRESS / RPC_URL / IS_TESTNET)
      EVM_NETWORK: evmId,
      NETWORK: evmId,
      USDC_ADDRESS: e.USDC_ADDRESS ?? evm.usdcAddress,
      RPC_URL: e.RPC_URL ?? evm.defaultRpcUrl,
      IS_TESTNET: evm.isTestnet,
      // Solana
      SOLANA_ENABLED: solEnabled,
      SOLANA_NETWORK: solId,
      SOLANA_USDC_MINT: sol ? (e.SOLANA_USDC_MINT ?? sol.usdcMint) : null,
      SOLANA_RPC_URL: sol ? (e.SOLANA_RPC_URL ?? sol.defaultRpcUrl) : null,
      SOLANA_IS_TESTNET: sol ? sol.isTestnet : null,
    };
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

/** Parse + validate process.env once. Throws a readable error if invalid. */
export function loadEnv(): Env {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}\n\nSee .env.example.`);
  }
  cached = parsed.data;
  return cached;
}
