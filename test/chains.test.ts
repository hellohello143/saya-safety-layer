import { describe, it, expect } from 'vitest';
import { makeEvmAdapter } from '../src/chains/evm.js';
import { makeSolanaAdapter } from '../src/chains/solana.js';
import { familyOf, isSolanaNetwork, isEvmNetwork } from '../src/config/network.js';

const EVM_ADDR = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const SOL_ADDR = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';

describe('chain adapters — per-chain address validation + family', () => {
  const evm = makeEvmAdapter('base-sepolia');
  const sol = makeSolanaAdapter('solana-devnet');

  it('EVM adapter accepts 0x hex, rejects base58', () => {
    expect(evm.family).toBe('evm');
    expect(evm.validateAddress(EVM_ADDR)).toBe(true);
    expect(evm.validateAddress(EVM_ADDR.toLowerCase())).toBe(true); // no strict checksum
    expect(evm.validateAddress(SOL_ADDR)).toBe(false);
  });

  it('Solana adapter accepts base58, rejects 0x hex and junk', () => {
    expect(sol.family).toBe('solana');
    expect(sol.validateAddress(SOL_ADDR)).toBe(true);
    expect(sol.validateAddress('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v')).toBe(true);
    expect(sol.validateAddress(EVM_ADDR)).toBe(false); // 0x/O/I/l are not base58
    expect(sol.validateAddress('not an address!')).toBe(false);
  });

  it('explorer links are chain-appropriate', () => {
    expect(evm.explorerTxUrl('0xabc')).toContain('basescan.org');
    expect(sol.explorerTxUrl('sig123')).toContain('explorer.solana.com');
    expect(sol.explorerTxUrl('sig123')).toContain('cluster=devnet');
  });
});

describe('network classification', () => {
  it('familyOf / isEvmNetwork / isSolanaNetwork', () => {
    expect(familyOf('base')).toBe('evm');
    expect(familyOf('solana-devnet')).toBe('solana');
    expect(isEvmNetwork('base-sepolia')).toBe(true);
    expect(isEvmNetwork('solana')).toBe(false);
    expect(isSolanaNetwork('solana')).toBe(true);
    expect(isSolanaNetwork('base')).toBe(false);
  });
});
