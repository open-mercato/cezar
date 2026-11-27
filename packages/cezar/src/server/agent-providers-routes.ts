import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import {
  providerActiveInputSchema, providerMethodInputSchema, providerMethodParamsSchema, providerRunnerParamsSchema,
} from '@open-mercato/cezar-contract';
import { applyProviderChanges, providerEntries, providerEntry, refreshProviderModels, removeProviderMethod, type ProviderLogin } from '../agent-providers/service.ts';
import { providerAuthChecksDisabled } from '../core/provider-auth.ts';
import { readAgentProviders } from '../workspace/agent-providers.ts';
import { jsonZodValidator, paramZodValidator } from './validators.ts';

export function agentProvidersRoutes(editable: () => boolean, statuses: () => Promise<ProviderLogin[]>) {
  const write: MiddlewareHandler = async (c, next) => editable() ? next() : c.json({ error: 'Configure providers on the host.' }, 409);
  return new Hono()
    .get('/agent-providers', async c => c.json({ editable: editable(), agents: await providerEntries(await statuses()),
      ...(providerAuthChecksDisabled() ? { nativeAuth: true as const } : {}),
    }))
    .put('/agent-providers/:runner/active', write, paramZodValidator(providerRunnerParamsSchema),
      jsonZodValidator(providerActiveInputSchema), async c => {
        const { runner } = c.req.valid('param');
        const logins = await statuses();
        try {
          await applyProviderChanges([{ runner, active: c.req.valid('json').methodId, methods: [] }], 'cockpit', logins);
          return c.json(providerEntry(runner, await readAgentProviders(), logins.find(l => l.provider === runner)));
        } catch (e) { return c.json({ error: providerError(e) }, 400); }
      })
    .put('/agent-providers/:runner/methods/:methodId', write, paramZodValidator(providerMethodParamsSchema),
      jsonZodValidator(providerMethodInputSchema, { message: 'Invalid provider method.' }), async c => {
        const { runner, methodId } = c.req.valid('param');
        const logins = await statuses();
        try {
          const fetches = await applyProviderChanges([{ runner, methods: [{ id: methodId, ...c.req.valid('json') }] }], 'cockpit', logins);
          if (fetches.length) await refreshProviderModels(runner, methodId);
          const entry = providerEntry(runner, await readAgentProviders(), logins.find(l => l.provider === runner));
          return c.json(entry.methods.find(m => m.id === methodId)!);
        } catch (e) { return c.json({ error: providerError(e) }, 400); }
      })
    .delete('/agent-providers/:runner/methods/:methodId', write, paramZodValidator(providerMethodParamsSchema), async c => {
      const { runner, methodId } = c.req.valid('param');
      try {
        await removeProviderMethod(runner, methodId);
        return c.body(null, 204);
      } catch (e) { return c.json({ error: providerError(e) }, 400); }
    })
    .post('/agent-providers/:runner/methods/:methodId/models', write, paramZodValidator(providerMethodParamsSchema), async c => {
      const { runner, methodId } = c.req.valid('param');
      try {
        const result = await refreshProviderModels(runner, methodId);
        if (result.error) return c.json({ error: result.error }, 400);
        return c.json({ models: result.models });
      } catch (e) { return c.json({ error: providerError(e) }, 400); }
    });
}

function providerError(error: unknown) {
  return error instanceof Error ? error.message : 'Provider configuration failed.';
}
