// CDP client bootstrap.
//
// Verified against @coinbase/cdp-sdk@1.51.2 (latest, 2026-06-18):
//   new CdpClient() reads CDP_API_KEY_ID / CDP_API_KEY_SECRET / CDP_WALLET_SECRET
//   from process.env. Create once, reuse.
// Source: https://cdn.jsdelivr.net/npm/@coinbase/cdp-sdk/README.md
//         docs/research/CDP_X402_RESEARCH.md §2–§3

import { CdpClient } from '@coinbase/cdp-sdk';
import { loadEnv } from '../config/env.js';

let client: CdpClient | null = null;

export function getCdpClient(): CdpClient {
  // loadEnv() fails fast with a readable error if any CDP_* var is missing.
  loadEnv();
  if (!client) {
    client = new CdpClient(); // reads the three CDP_* env vars
  }
  return client;
}

// Handy inferred SDK object types (avoids guessing exported type names).
export type Evm = CdpClient['evm'];
export type TreasurySmartAccount = Awaited<ReturnType<Evm['getOrCreateSmartAccount']>>;
export type ServerAccount = Awaited<ReturnType<Evm['getOrCreateAccount']>>;
