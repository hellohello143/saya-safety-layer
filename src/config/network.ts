// Network config. The safety layer can serve EVM (Base) and Solana simultaneously.
// EVM_NETWORK + SOLANA_NETWORK each select a chain (or 'off'); USDC address/mint,
// RPC, and chain follow from the selection. Solana defaults to devnet.
//
// ⚠️ NETWORK=base / SOLANA_NETWORK=solana mean REAL money. API auth is REQUIRED
// on mainnet (the server refuses to start without API_TOKEN) and several limits
// are soft-enforced — read the README "Security & production readiness" first.

import { base, baseSepolia } from 'viem/chains';
import type { Chain } from 'viem';

export type EvmNetworkId = 'base' | 'base-sepolia';
export type SolanaNetworkId = 'solana' | 'solana-devnet';
export type NetworkId = EvmNetworkId | SolanaNetworkId;
export type ChainFamily = 'evm' | 'solana';

export interface EvmNetworkConfig {
  family: 'evm';
  id: EvmNetworkId;
  viemChain: Chain;
  usdcAddress: `0x${string}`;
  defaultRpcUrl: string;
  isTestnet: boolean;
  explorerTxUrl: (hash: string) => string;
}

export interface SolanaNetworkConfig {
  family: 'solana';
  id: SolanaNetworkId;
  cdpNetwork: SolanaNetworkId; // cdp.solana network string (same values)
  usdcMint: string; // base58 SPL mint
  usdcDecimals: 6;
  defaultRpcUrl: string;
  isTestnet: boolean;
  explorerTxUrl: (sig: string) => string;
}

export const EVM_NETWORKS: Record<EvmNetworkId, EvmNetworkConfig> = {
  'base-sepolia': {
    family: 'evm',
    id: 'base-sepolia',
    viemChain: baseSepolia,
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    defaultRpcUrl: 'https://sepolia.base.org',
    isTestnet: true,
    explorerTxUrl: (h) => `https://sepolia.basescan.org/tx/${h}`,
  },
  base: {
    family: 'evm',
    id: 'base',
    viemChain: base,
    usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    defaultRpcUrl: 'https://mainnet.base.org',
    isTestnet: false,
    explorerTxUrl: (h) => `https://basescan.org/tx/${h}`,
  },
};

export const SOLANA_NETWORKS: Record<SolanaNetworkId, SolanaNetworkConfig> = {
  'solana-devnet': {
    family: 'solana',
    id: 'solana-devnet',
    cdpNetwork: 'solana-devnet',
    usdcMint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU', // Circle devnet USDC
    usdcDecimals: 6,
    defaultRpcUrl: 'https://api.devnet.solana.com',
    isTestnet: true,
    explorerTxUrl: (s) => `https://explorer.solana.com/tx/${s}?cluster=devnet`,
  },
  solana: {
    family: 'solana',
    id: 'solana',
    cdpNetwork: 'solana',
    usdcMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // Circle mainnet USDC
    usdcDecimals: 6,
    defaultRpcUrl: 'https://api.mainnet-beta.solana.com',
    isTestnet: false,
    explorerTxUrl: (s) => `https://explorer.solana.com/tx/${s}`,
  },
};

export function familyOf(id: NetworkId): ChainFamily {
  return id === 'solana' || id === 'solana-devnet' ? 'solana' : 'evm';
}

export function isEvmNetwork(id: string): id is EvmNetworkId {
  return id === 'base' || id === 'base-sepolia';
}
export function isSolanaNetwork(id: string): id is SolanaNetworkId {
  return id === 'solana' || id === 'solana-devnet';
}
