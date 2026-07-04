// Audit log service. Thin domain wrapper over AuditRepository so callers record
// intents with a consistent shape. Every payment intent — approved,
// policy-rejected, or on-chain-rejected — flows through here (spec §4). No code
// path in the payment flow may skip this.

import { randomUUID } from 'node:crypto';
import type { Decision, RejectionReason } from '../policy/reasonCodes.js';
import { AuditRepository, type AuditQuery } from '../db/repositories/auditRepository.js';
import type { AuditRow } from '../db/schema.js';

const repo = new AuditRepository();

export interface AuditEntry {
  sessionId?: string;
  agentId: string;
  network?: string;
  targetUrl?: string;
  requestedAmount?: bigint; // base units
  recipient?: string;
  decision: Decision;
  reasonCode?: RejectionReason;
  riskFlags?: string[];
  txHash?: string;
  onchainStatus?: 'pending' | 'confirmed' | 'failed';
}

/** Record one payment intent. Returns the audit row id for later status updates. */
export async function recordIntent(entry: AuditEntry): Promise<{ id: string }> {
  const id = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await repo.record({
    id,
    sessionId: entry.sessionId ?? null,
    agentId: entry.agentId,
    network: entry.network ?? null,
    timestamp: now,
    targetUrl: entry.targetUrl ?? null,
    requestedAmount: entry.requestedAmount !== undefined ? entry.requestedAmount.toString() : null,
    recipient: entry.recipient ?? null,
    decision: entry.decision,
    reasonCode: entry.reasonCode ?? null,
    riskFlags: entry.riskFlags ?? null,
    txHash: entry.txHash ?? null,
    onchainStatus: entry.onchainStatus ?? null,
  });
  return { id };
}

export async function markOnchainResult(
  auditId: string,
  status: 'confirmed' | 'failed',
  txHash?: string,
): Promise<void> {
  await repo.updateOnchainStatus(auditId, status, txHash);
}

export async function queryAudit(q: AuditQuery): Promise<AuditRow[]> {
  return repo.query(q);
}
