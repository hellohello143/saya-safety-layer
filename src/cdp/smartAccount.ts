// Smart account + spender management.
//
// Verified (docs/research/CDP_X402_RESEARCH.md §3):
//   - Smart Accounts are ERC-4337, Base Sepolia + Base mainnet only; user ops
//     are gasless via the CDP Paymaster on Base Sepolia.
//   - Spend Permissions REQUIRE a smart account owned by a CDP Server Wallet EOA,
//     created with enableSpendPermissions: true.
//   Source: https://docs.cdp.coinbase.com/server-wallets/v2/evm-features/spend-permissions
//   - Faucet: cdp.evm.requestFaucet({ address, network:'base-sepolia', token })
//
// Account model (decision — see CP2 report):
//   TREASURY = the agent's smart account (holds test USDC; the permission's
//     `account`). Gasless via paymaster.
//   SPENDER  = a CDP EVM account (EOA); the permission's `spender`, i.e. the
//     address funds are pulled TO. It later pays merchants via x402. Because
//     spend() pins the payee to this address, the spender key is high-value.

import { getCdpClient, type TreasurySmartAccount } from './client.js';
import { loadEnv } from '../config/env.js';

// Both the treasury and the spender are CDP smart accounts so their user ops are
// gasless via the CDP Paymaster on Base Sepolia (only the treasury needs USDC).
export type SmartAccount = TreasurySmartAccount;

let treasury: SmartAccount | null = null;
let spender: SmartAccount | null = null;

/** The agent treasury smart account (owned by a CDP Server Wallet EOA). */
export async function getTreasury(): Promise<SmartAccount> {
  if (treasury) return treasury;
  const cdp = getCdpClient();
  const env = loadEnv();
  const owner = await cdp.evm.getOrCreateAccount({ name: env.CDP_OWNER_ACCOUNT_NAME });
  treasury = await cdp.evm.getOrCreateSmartAccount({
    name: env.CDP_SMART_ACCOUNT_NAME,
    owner,
    enableSpendPermissions: true,
  });
  return treasury;
}

/**
 * The safety-layer spender smart account — the permission's `spender` and the
 * address funds are pulled TO. It calls useSpendPermission (gasless) and later
 * pays merchants via x402. Because spend() pins the payee to this address, the
 * spender is high-value: only this backend may drive it.
 */
export async function getSpender(): Promise<SmartAccount> {
  if (spender) return spender;
  const cdp = getCdpClient();
  const env = loadEnv();
  const owner = await cdp.evm.getOrCreateAccount({ name: `${env.CDP_SPENDER_ACCOUNT_NAME}-owner` });
  spender = await cdp.evm.getOrCreateSmartAccount({
    name: env.CDP_SPENDER_ACCOUNT_NAME,
    owner,
  });
  return spender;
}

/** Fund an address with test USDC via the CDP faucet (Base Sepolia). */
export async function fundWithTestUsdc(address: string): Promise<{ transactionHash: string }> {
  const cdp = getCdpClient();
  const res = await cdp.evm.requestFaucet({
    address: address as `0x${string}`,
    network: 'base-sepolia',
    token: 'usdc',
  });
  return { transactionHash: res.transactionHash };
}

/** Fund an address with test ETH (for the spender EOA's gas when it spends). */
export async function fundWithTestEth(address: string): Promise<{ transactionHash: string }> {
  const cdp = getCdpClient();
  const res = await cdp.evm.requestFaucet({
    address: address as `0x${string}`,
    network: 'base-sepolia',
    token: 'eth',
  });
  return { transactionHash: res.transactionHash };
}
