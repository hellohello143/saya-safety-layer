// Database schema + row types.
//
// DRIVER DECISION (see src/db/client.ts): the user runs Node v26, which has no
// better-sqlite3 prebuild and no local C++ toolchain, and drizzle-orm's released
// version ships no `node:sqlite` adapter. Per spec ("if Drizzle's SQLite support
// hits a wall"), we use Node's built-in `node:sqlite` directly behind this
// repository layer. All DB access stays isolated here, so swapping to Postgres
// later is a repository change, not an app-wide rewrite.
//
// Money columns store USDC BASE UNITS (6dp) as TEXT (SQLite REAL/INTEGER can't
// hold uint160 exactly); parse to bigint via src/money. Timestamps are unix sec.
//
// Mapping to on-chain CDP Spend Permission (docs/research/CDP_X402_RESEARCH.md):
//   expiresAt        -> permission.end            (ON-CHAIN enforced)
//   maxAmountTotal   -> permission.allowance       (ON-CHAIN via single-window cfg)
//   maxAmountPerTx   -> (no on-chain field)        (SOFT only)
//   allowedRecipients-> (no on-chain field)        (SOFT only; empty => higher_risk)

export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id                    TEXT PRIMARY KEY,
  agent_id              TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',      -- active|suspended|expired|revoked
  network               TEXT NOT NULL DEFAULT 'base-sepolia',-- base|base-sepolia|solana|solana-devnet
  smart_account_address TEXT NOT NULL,                       -- EVM smart account / Solana treasury owner
  spender_address       TEXT NOT NULL,                       -- EVM spender / Solana delegate
  token_address         TEXT NOT NULL,                       -- USDC address (EVM) / mint (Solana)
  token_account         TEXT,                                -- Solana token account (ATA) the delegate spends from
  permission_hash       TEXT,                                -- EVM permission hash / Solana Approve signature
  max_amount_per_tx     TEXT NOT NULL,                       -- base units
  max_amount_total      TEXT NOT NULL,                       -- base units
  expires_at            INTEGER NOT NULL,                    -- unix seconds
  allowed_recipients    TEXT NOT NULL DEFAULT '[]',          -- JSON string[]
  higher_risk           INTEGER NOT NULL DEFAULT 0,          -- 0|1
  flagged_for_review    INTEGER NOT NULL DEFAULT 0,          -- 0|1
  cumulative_spent      TEXT NOT NULL DEFAULT '0',           -- base units
  create_tx_hash        TEXT,
  revoke_tx_hash        TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);

CREATE TABLE IF NOT EXISTS audit_log (
  id               TEXT PRIMARY KEY,
  session_id       TEXT,
  agent_id         TEXT NOT NULL,
  network          TEXT,                                     -- chain the intent was on
  timestamp        INTEGER NOT NULL,                         -- unix seconds
  target_url       TEXT,
  requested_amount TEXT,                                     -- base units
  recipient        TEXT,
  decision         TEXT NOT NULL,                            -- approved|rejected_policy|rejected_onchain
  reason_code      TEXT,
  risk_flags       TEXT,                                     -- JSON string[]
  tx_hash          TEXT,
  onchain_status   TEXT,                                     -- pending|confirmed|failed|null
  created_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_agent ON audit_log(agent_id);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
CREATE INDEX IF NOT EXISTS idx_audit_decision ON audit_log(decision);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(timestamp);

-- In-flight payment attempts: rows that passed the circuit breaker but haven't
-- written their terminal audit row yet. The breaker counts these on top of
-- committed attempts so a concurrent burst can't slip past before rows land.
-- SQLite-backed (not in-memory) so the count is shared across processes and
-- survives restart; stale rows are ignored by the breaker's rolling window.
CREATE TABLE IF NOT EXISTS breaker_inflight (
  id         TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL                                 -- unix seconds
);
CREATE INDEX IF NOT EXISTS idx_inflight_session ON breaker_inflight(session_id);
`;

// Camel-cased row shapes returned by the repositories (SELECTs alias columns).
export interface SessionRow {
  id: string;
  agentId: string;
  status: string;
  network: string; // base | base-sepolia | solana | solana-devnet
  smartAccountAddress: string;
  spenderAddress: string;
  tokenAddress: string;
  tokenAccount: string | null; // Solana ATA the delegate spends from (null for EVM)
  permissionHash: string | null;
  maxAmountPerTx: string; // base units
  maxAmountTotal: string; // base units
  expiresAt: number;
  allowedRecipients: string[];
  higherRisk: boolean;
  flaggedForReview: boolean;
  cumulativeSpent: string; // base units
  createTxHash: string | null;
  revokeTxHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export type NewSessionRow = Omit<SessionRow, 'createdAt' | 'updatedAt'> &
  Partial<Pick<SessionRow, 'createdAt' | 'updatedAt'>>;

export interface AuditRow {
  id: string;
  sessionId: string | null;
  agentId: string;
  network: string | null;
  timestamp: number;
  targetUrl: string | null;
  requestedAmount: string | null;
  recipient: string | null;
  decision: string;
  reasonCode: string | null;
  riskFlags: string[] | null;
  txHash: string | null;
  onchainStatus: string | null;
  createdAt: number;
}

export type NewAuditRow = Omit<AuditRow, 'createdAt'> & Partial<Pick<AuditRow, 'createdAt'>>;
