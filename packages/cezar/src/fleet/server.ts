import { createHash, timingSafeEqual } from 'node:crypto';
import { serve, type ServerType } from '@hono/node-server';
import { Hono, type MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { fleetHeartbeatSchema, fleetSubmitSchema } from '@open-mercato/cezar-contract';
import { jsonZodValidator, paramZodValidator } from '../server/validators.ts';
import { FLEET_MIN_TOKEN_LENGTH } from './config.ts';
import type { FleetHub } from './hub.ts';

/**
 * The fleet listener (spec 2026-10-21-fleet-coordination): a SEPARATE port from the cockpit that
 * serves `/api/v1/fleet/*` and nothing else, every request behind a bearer token. The cockpit API
 * itself stays loopback-only and unauthenticated, exactly as before.
 */

/** Constant-time token check. Both sides are hashed first so a length mismatch leaks nothing. */
export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented || expected.length < FLEET_MIN_TOKEN_LENGTH) return false;
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** 401 unless `Authorization: Bearer <token>` matches. A too-short configured token fails closed. */
export function fleetAuth(token: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? '';
    const presented = /^Bearer (.+)$/i.exec(header)?.[1];
    if (!tokenMatches(presented, token)) return c.json({ error: 'unauthorized' }, 401);
    await next();
  };
}

/** Bodies are capped before they are read: the token is shared, so a leaked one must not buy memory. */
const limit = (maxSize: number) => bodyLimit({ maxSize, onError: (c) => c.json({ error: 'payload too large' }, 413) });

const jobIdParam = z.object({ id: z.string().min(1).max(100) });

export function createFleetApp(hub: FleetHub, token: string) {
  const routes = new Hono()
    .use('*', fleetAuth(token))
    .post('/heartbeat', limit(512 * 1024), jsonZodValidator(fleetHeartbeatSchema), (c) => c.json(hub.heartbeat(c.req.valid('json'))))
    .get('/status', (c) => c.json(hub.status()))
    .post('/jobs', limit(256 * 1024), jsonZodValidator(fleetSubmitSchema), (c) => c.json(hub.submit(c.req.valid('json')), 201))
    .post('/jobs/:id/cancel', paramZodValidator(jobIdParam), (c) => {
      const job = hub.cancel(c.req.valid('param').id);
      return job ? c.json(job) : c.json({ error: 'not found' }, 404);
    });
  // Anything outside /api/v1/fleet is a plain 404 — the listener exposes no other surface.
  return new Hono().route('/api/v1/fleet', routes);
}

export function startFleetServer(hub: FleetHub, token: string, port: number, bind: string): ServerType {
  return serve({ fetch: createFleetApp(hub, token).fetch, port, hostname: bind });
}
