// Payment routes. The agent-facing entrypoint: submit a payment intent
// (session id + target URL) and get back the resource or a structured rejection
// with a machine-readable reason code.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { payForResource } from '../x402/middleware.js';

const PayBody = z.object({
  sessionId: z.string().min(1),
  targetUrl: z.string().url(),
  method: z.string().optional(),
});

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  // POST /api/pay { sessionId, targetUrl } -> approved+resource | structured rejection
  app.post('/api/pay', async (req, reply) => {
    const parsed = PayBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
    }
    const result = await payForResource(parsed.data);
    // Map decision -> HTTP status: approved 200, policy 402, on-chain 502.
    const code = result.status === 'approved' ? 200 : result.status === 'rejected_policy' ? 402 : 502;
    return reply.code(code).send(result);
  });
}
