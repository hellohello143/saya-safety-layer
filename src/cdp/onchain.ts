// Direct on-chain reads of the SpendPermissionManager via viem. This is the
// authoritative source of truth — more trustworthy than the indexed
// listSpendPermissions API for "is this permission live right now?".
//
// Manager singleton (same address on every supported chain incl. Base Sepolia):
//   0xf85210B21cC50302F477BA56686d2019dC9b67Ad
// ABI verbatim from docs/research/SpendPermissionManager.reference.sol.
//
// IMPORTANT: isValid() checks approved-AND-not-revoked ONLY; it does NOT check
// the [start, end) time window (the window is enforced in getCurrentPeriod, and
// thus every spend()). So "live right now" = isValid AND start <= now < end.

import { createPublicClient, http, getAddress, type Hex } from 'viem';
import type { SpendPermission } from '@coinbase/cdp-sdk';
import { loadEnv } from '../config/env.js';
import { EVM_NETWORKS } from '../config/network.js';
import { getCdpClient } from './client.js';

// Minimal ABI: the SpendPermission tuple + the view functions we need.
const SPEND_PERMISSION_TUPLE = {
  type: 'tuple',
  name: 'spendPermission',
  components: [
    { name: 'account', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'token', type: 'address' },
    { name: 'allowance', type: 'uint160' },
    { name: 'period', type: 'uint48' },
    { name: 'start', type: 'uint48' },
    { name: 'end', type: 'uint48' },
    { name: 'salt', type: 'uint256' },
    { name: 'extraData', type: 'bytes' },
  ],
} as const;

const MANAGER_ABI = [
  { type: 'function', name: 'isValid', stateMutability: 'view', inputs: [SPEND_PERMISSION_TUPLE], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isApproved', stateMutability: 'view', inputs: [SPEND_PERMISSION_TUPLE], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isRevoked', stateMutability: 'view', inputs: [SPEND_PERMISSION_TUPLE], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getHash', stateMutability: 'view', inputs: [SPEND_PERMISSION_TUPLE], outputs: [{ type: 'bytes32' }] },
  {
    type: 'function',
    name: 'getCurrentPeriod',
    stateMutability: 'view',
    inputs: [SPEND_PERMISSION_TUPLE],
    outputs: [
      {
        type: 'tuple',
        components: [
          { name: 'start', type: 'uint48' },
          { name: 'end', type: 'uint48' },
          { name: 'spend', type: 'uint160' },
        ],
      },
    ],
  },
] as const;

function createClient() {
  const env = loadEnv();
  return createPublicClient({
    chain: EVM_NETWORKS[env.NETWORK].viemChain,
    transport: http(env.RPC_URL),
  });
}
let publicClient: ReturnType<typeof createClient> | null = null;
function getPublicClient(): ReturnType<typeof createClient> {
  if (!publicClient) publicClient = createClient();
  return publicClient;
}

function managerAddress(): Hex {
  return getAddress(loadEnv().SPEND_PERMISSION_MANAGER_ADDRESS) as Hex;
}

// viem infers `number` for uint48 (period/start/end) and `bigint` for
// uint160/uint256 (allowance/salt) — which is exactly how the SDK types them, so
// the fields pass through unchanged; we only checksum the addresses.
function toAbiTuple(p: SpendPermission) {
  return {
    account: getAddress(p.account),
    spender: getAddress(p.spender),
    token: getAddress(p.token),
    allowance: p.allowance,
    period: p.period,
    start: p.start,
    end: p.end,
    salt: p.salt,
    extraData: p.extraData,
  };
}

const ERC20_BALANCE_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Read an address's USDC balance (base units) directly on-chain via viem. */
export async function usdcBalance(address: string): Promise<bigint> {
  const env = loadEnv();
  const client = getPublicClient();
  return (await client.readContract({
    address: getAddress(env.USDC_ADDRESS),
    abi: ERC20_BALANCE_ABI,
    functionName: 'balanceOf',
    args: [getAddress(address)],
  })) as bigint;
}

export interface OnchainStatus {
  found: boolean;
  isApproved: boolean;
  isRevoked: boolean;
  isValid: boolean; // approved && !revoked (NOT time-window aware)
  withinWindow: boolean; // start <= now < end
  live: boolean; // isValid && withinWindow — the real "can spend now?"
  spentThisPeriod: string | null; // base units (string) or null if outside window
  remainingAllowance: string | null; // base units (string) or null if outside window
}

/** Fetch the on-chain SpendPermission struct for a hash (via the indexed list). */
export async function fetchPermissionByHash(
  smartAccountAddress: string,
  permissionHash: string,
): Promise<SpendPermission | null> {
  const cdp = getCdpClient();
  const list = await cdp.evm.listSpendPermissions({ address: smartAccountAddress as `0x${string}` });
  const match = list.spendPermissions.find(
    (p) => p.permissionHash.toLowerCase() === permissionHash.toLowerCase(),
  );
  return match ? match.permission : null;
}

/** Authoritative on-chain status read for a permission. */
export async function readOnchainStatus(
  smartAccountAddress: string,
  permissionHash: string,
): Promise<OnchainStatus> {
  const permission = await fetchPermissionByHash(smartAccountAddress, permissionHash);
  if (!permission) {
    return {
      found: false,
      isApproved: false,
      isRevoked: false,
      isValid: false,
      withinWindow: false,
      live: false,
      spentThisPeriod: null,
      remainingAllowance: null,
    };
  }

  const client = getPublicClient();
  const addr = managerAddress();
  const tuple = toAbiTuple(permission);

  const [approved, revoked, valid] = await Promise.all([
    client.readContract({ address: addr, abi: MANAGER_ABI, functionName: 'isApproved', args: [tuple] }),
    client.readContract({ address: addr, abi: MANAGER_ABI, functionName: 'isRevoked', args: [tuple] }),
    client.readContract({ address: addr, abi: MANAGER_ABI, functionName: 'isValid', args: [tuple] }),
  ]);

  const nowSec = Math.floor(Date.now() / 1000);
  const withinWindow = nowSec >= permission.start && nowSec < permission.end;

  // getCurrentPeriod reverts outside [start, end); treat a revert as "no current period".
  let spentThisPeriod: string | null = null;
  let remainingAllowance: string | null = null;
  if (withinWindow) {
    try {
      const period = (await client.readContract({
        address: addr,
        abi: MANAGER_ABI,
        functionName: 'getCurrentPeriod',
        args: [tuple],
      })) as { start: number; end: number; spend: bigint };
      spentThisPeriod = period.spend.toString();
      remainingAllowance = (permission.allowance - period.spend).toString();
    } catch {
      /* outside window / not yet started — leave nulls */
    }
  }

  return {
    found: true,
    isApproved: approved as boolean,
    isRevoked: revoked as boolean,
    isValid: valid as boolean,
    withinWindow,
    live: (valid as boolean) && withinWindow,
    spentThisPeriod,
    remainingAllowance,
  };
}
