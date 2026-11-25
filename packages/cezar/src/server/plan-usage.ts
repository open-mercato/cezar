import { Hono } from 'hono';
import {
  PLAN_USAGE_RETENTION_DAYS, planUsageConsumersQuerySchema, planUsageQuerySchema, planUsageTrackingUpdateSchema,
} from '@open-mercato/cezar-contract';
import { buildPlanUsageConsumers, buildPlanUsageReport } from '../usage-ledger/report.ts';
import { planUsageTracking, setAccountTracking } from '../usage-ledger/store.ts';
import { jsonZodValidator, queryZodValidator } from './validators.ts';

/**
 * Plan-limit usage (design rev 3). Workspace-level and single-mount: accounts belong to the
 * machine, and one ledger covers every project. The same report `cez usage --json` prints.
 */
export function planUsageRoutes() {
  return new Hono()
    .get('/workspace/plan-usage', queryZodValidator(planUsageQuerySchema), (c) =>
      c.json(buildPlanUsageReport(c.req.valid('query'))))
    .get('/workspace/plan-usage/consumers', queryZodValidator(planUsageConsumersQuerySchema), (c) => {
      const query = c.req.valid('query');
      const ids = query.ids?.split(',').map((id) => id.trim()).filter(Boolean).slice(0, 500);
      return c.json(buildPlanUsageConsumers(ids, query.days ?? Math.min(14, PLAN_USAGE_RETENTION_DAYS)));
    })
    .get('/workspace/plan-usage/tracking', (c) => c.json(planUsageTracking()))
    .put('/workspace/plan-usage/tracking', jsonZodValidator(planUsageTrackingUpdateSchema), (c) => {
      const { account, enabled } = c.req.valid('json');
      try {
        return c.json(setAccountTracking(account, enabled), 200);
      } catch {
        return c.json({ error: 'Could not save the tracking setting (is the cezar home writable?)' }, 409);
      }
    });
}
