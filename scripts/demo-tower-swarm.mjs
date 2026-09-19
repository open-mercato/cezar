#!/usr/bin/env node
/**
 * Demo swarm for Control Tower.
 *
 * Usage (cockpit already running with CEZ_DRY_RUN=1):
 *   node scripts/demo-tower-swarm.mjs
 *   CEZ_API_PORT=4322 node scripts/demo-tower-swarm.mjs   # if port bumped
 *
 * Then open Tower → set Max RSS MiB = 1 → Save → Apply governor.
 */
const port = process.env.CEZ_API_PORT || process.env.PORT || '4321';
const base = `http://127.0.0.1:${port}`;

async function json(path, init) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${path} → ${res.status} ${JSON.stringify(body)}`);
  return body;
}

const health = await json('/api/v1/health');
if (health.capabilities?.autopilot === false) {
  console.error('Autopilot is off (CEZ_AUTOPILOT=0). Restart without that flag.');
  process.exit(1);
}

// Raise parallelism so the swarm actually runs together.
await json('/api/v1/workspace/config', {
  method: 'PUT',
  body: JSON.stringify({ resources: { maxParallel: 8 } }),
});

// Dry-run mock is the Claude binary path — enable Claude even if the user disabled it earlier.
await json('/api/v1/providers/claude/enabled', {
  method: 'PUT',
  body: JSON.stringify({ enabled: true }),
});

const prompts = [
  'Agent Alpha — hold the line mock:slow',
  'Agent Bravo — hold the line mock:slow',
  'Agent Charlie — hold the line mock:slow',
  'Agent Delta — park on downstream mock:monitoring',
  'Agent Echo — park on downstream mock:monitoring',
  'Agent Foxtrot — hold the line mock:slow',
  'Agent Golf — hold the line mock:slow',
  'Agent Hotel — park on downstream mock:monitoring',
];

console.log(`Spawning ${prompts.length} dry-run agents against ${base} …`);
const ids = [];
for (const task of prompts) {
  const created = await json('/api/v1/runs', {
    method: 'POST',
    body: JSON.stringify({
      task,
      workflow: 'quick-task',
      worktree: false,
      autonomous: true,
    }),
  });
  const id = created.id ?? created.runs?.[0]?.id;
  ids.push(id);
  console.log(`  → ${id}  ${task.slice(0, 40)}…`);
}

// Tighten governor for an instant Apply demo (RSS sum will exceed 1 MiB).
await json('/api/v1/workspace/autopilot/governor', {
  method: 'PUT',
  body: JSON.stringify({
    maxSpendUsdPerHour: null,
    maxRssMbTotal: 1,
    stuckAfterMinutes: 1,
    softMaxParallel: 2,
  }),
});

const tower = await json('/api/v1/workspace/autopilot/tower');
console.log('\nTower snapshot:');
console.log(`  running=${tower.running} queued=${tower.queued} rss=${Math.round(tower.totalRssMb)} MiB`);
console.log(`  actions(preview)=${tower.actions.map((a) => a.kind).join(', ') || '(none yet — wait ~2s for ps samples)'}`);

console.log(`
Next (demo script):
  1. Open ${base.replace('4321', port)} → sidebar Tower
  2. Confirm Live agents list is full
  3. Caps already set: Max RSS = 1 MiB, Stuck = 1 min, soft maxParallel = 2
  4. Click Apply governor → heaviest RSS runs pause
  5. Optional: Preview first, then Apply
  6. Open a paused task → note about Control Tower → Continue

Cleanup later: cancel leftover runs from the Tasks list.
`);
