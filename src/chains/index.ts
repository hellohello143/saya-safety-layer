// Chain dispatch. Given a network id, return the right adapter. Routes, the
// circuit breaker, and (later) the payment flow call adapterFor(session.network)
// so they never branch on chain themselves.

import { loadEnv } from '../config/env.js';
import { isEvmNetwork, isSolanaNetwork, type NetworkId } from '../config/network.js';
import { makeEvmAdapter } from './evm.js';
import { makeSolanaAdapter } from './solana.js';
import type { ChainAdapter } from './types.js';

export type { ChainAdapter, IssueSessionParams, IssuedSession, OnchainSessionStatus } from './types.js';

/** Adapter for a network id. Throws if the network is unknown or disabled. */
export function adapterFor(network: string): ChainAdapter {
  const env = loadEnv();
  if (isEvmNetwork(network)) {
    return makeEvmAdapter(network);
  }
  if (isSolanaNetwork(network)) {
    if (!env.SOLANA_ENABLED) {
      throw new Error(`Solana is not enabled (network ${network}); set SOLANA_NETWORK`);
    }
    return makeSolanaAdapter(network);
  }
  throw new Error(`unknown network: ${network}`);
}

/** The set of networks the operator has enabled (for the create form / API). */
export function enabledNetworks(): NetworkId[] {
  const env = loadEnv();
  const nets: NetworkId[] = [env.EVM_NETWORK];
  if (env.SOLANA_ENABLED && env.SOLANA_NETWORK) nets.push(env.SOLANA_NETWORK);
  return nets;
}

/** Validate an address for a given network without constructing the full adapter. */
export function validateAddressForNetwork(network: string, addr: string): boolean {
  return adapterFor(network).validateAddress(addr);
}
