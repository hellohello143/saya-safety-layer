// Audit routes. Queryable/filterable audit log for the dashboard (by agent, date
// range, decision/status) — spec §4/§6.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { baseUnitsToUsdc } from '../money/usdc.js';
import { queryAudit } from '../audit/auditLog.js';
import type { AuditRow } from '../db/schema.js';

const AuditQuerySchema = z.object({
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  decision: z.enum(['approved', 'rejected_policy', 'rejected_onchain']).optional(),
  onchainStatus: z.enum(['pending', 'confirmed', 'failed']).optional(),
  from: z.coerce.number().int().optional(),
  to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
});

function serialize(row: AuditRow) {
  return {
    ...row,
    requestedAmount: row.requestedAmount ? baseUnitsToUsdc(BigInt(row.requestedAmount)) : null,
  };
}

export async function auditRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/audit?agentId&sessionId&decision&onchainStatus&from&to&limit
  app.get('/api/audit', async (req, reply) => {
    const parsed = AuditQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const rows = await queryAudit(parsed.data);
    return reply.send(rows.map(serialize));
  });
}
