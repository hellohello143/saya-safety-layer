// Machine-readable rejection reason codes returned to callers when a payment
// intent is denied. Source: project spec §2.3. Extend as needed, but keep the
// values stable — callers switch on them.

export const REJECTION_REASONS = [
  'SESSION_NOT_FOUND',
  'SESSION_EXPIRED',
  'SESSION_SUSPENDED',
  'SESSION_REVOKED',
  'EXCEEDS_PER_TX_LIMIT',
  'EXCEEDS_TOTAL_LIMIT',
  'RECIPIENT_NOT_ALLOWED',
  'WRONG_ASSET',
  'WRONG_NETWORK',
  // extensions (spec permits extending the enum):
  'INVALID_AMOUNT', // seller amount <= 0
  'NO_PAYMENT_REQUIREMENTS', // 402 had no usable exact-scheme requirement (or a malformed amount)
  'RATE_LIMIT_TRIPPED',
  'ONCHAIN_REJECTED',
  'ONCHAIN_ERROR',
] as const;

export type RejectionReason = (typeof REJECTION_REASONS)[number];

// Decision recorded on every audit-log row (spec §4).
export const DECISIONS = ['approved', 'rejected_policy', 'rejected_onchain'] as const;
export type Decision = (typeof DECISIONS)[number];
