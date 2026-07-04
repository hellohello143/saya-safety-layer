// Accounts route. Exposes the resolved CDP account addresses so the operator
// knows where to send test USDC (the treasury) and which address pulls funds
// (the spender). Handy for the dashboard "fund this address" panel.

import type { FastifyInstance } from 'fastify';
import { loadEnv } from '../config/env.js';
import { getTreasury, getSpender } from '../cdp/smartAccount.js';

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  const env = loadEnv();

  // GET /api/accounts -> { treasury, spender, network, usdcAddress }
  app.get('/api/accounts', async (_req, reply) => {
    try {
      const [treasury, spender] = await Promise.all([getTreasury(), getSpender()]);
      return reply.send({
        treasury: treasury.address,
        spender: spender.address,
        network: env.NETWORK,
        usdcAddress: env.USDC_ADDRESS,
      });
    } catch (err) {
      return reply.code(502).send({ error: 'cdp_error', message: (err as Error).message });
    }
  });
}
