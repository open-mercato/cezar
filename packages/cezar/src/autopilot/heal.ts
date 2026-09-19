/**
 * Self-Heal cycle ledger — plain files under `<dataDir>/heal/<cycleId>/cycle.json`.
 */
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import {
  createHealCycleInputSchema,
  healCycleSchema,
  type CreateHealCycleInput,
  type HealCycle,
  type PatchHealCycleInput,
} from '@open-mercato/cezar-contract';

export function healRoot(dataDir: string): string {
  return join(dataDir, 'heal');
}

export function healCyclePath(dataDir: string, cycleId: string): string {
  return join(healRoot(dataDir), cycleId, 'cycle.json');
}

function newCycleId(): string {
  return randomBytes(4).toString('hex');
}

export function createHealCycle(dataDir: string, input: CreateHealCycleInput): HealCycle {
  const parsed = createHealCycleInputSchema.parse(input);
  const now = new Date().toISOString();
  const cycle: HealCycle = {
    id: newCycleId(),
    createdAt: now,
    updatedAt: now,
    status: 'scouting',
    brief: parsed.brief,
    ...(parsed.successCriteria ? { successCriteria: parsed.successCriteria } : {}),
    ...(parsed.budgetUsd !== undefined ? { budgetUsd: parsed.budgetUsd } : {}),
    maxCandidates: parsed.maxCandidates ?? 5,
    ...(parsed.rootRunId ? { rootRunId: parsed.rootRunId } : {}),
    candidates: [],
  };
  writeCycle(dataDir, cycle);
  return cycle;
}

export function writeCycle(dataDir: string, cycle: HealCycle): void {
  const parsed = healCycleSchema.parse(cycle);
  const dir = join(healRoot(dataDir), parsed.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = healCyclePath(dataDir, parsed.id);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(parsed, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function readHealCycle(dataDir: string, cycleId: string): Promise<HealCycle | null> {
  try {
    const raw = JSON.parse(await readFile(healCyclePath(dataDir, cycleId), 'utf8')) as unknown;
    return healCycleSchema.parse(raw);
  } catch {
    return null;
  }
}

export function listHealCycles(dataDir: string): HealCycle[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(healRoot(dataDir), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const cycles: HealCycle[] = [];
  for (const id of ids) {
    try {
      const raw = JSON.parse(readFileSync(healCyclePath(dataDir, id), 'utf8')) as unknown;
      cycles.push(healCycleSchema.parse(raw));
    } catch {
      // skip corrupt
    }
  }
  return cycles.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function patchHealCycle(
  dataDir: string,
  cycleId: string,
  patch: PatchHealCycleInput,
): Promise<HealCycle | null> {
  const current = await readHealCycle(dataDir, cycleId);
  if (!current) return null;
  const next: HealCycle = {
    ...current,
    updatedAt: new Date().toISOString(),
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.candidates ? { candidates: patch.candidates } : {}),
  };
  if (patch.winnerRunId === null) delete (next as { winnerRunId?: string }).winnerRunId;
  else if (patch.winnerRunId !== undefined) next.winnerRunId = patch.winnerRunId;
  if (patch.draftPrUrl === null) delete (next as { draftPrUrl?: string }).draftPrUrl;
  else if (patch.draftPrUrl !== undefined) next.draftPrUrl = patch.draftPrUrl;
  if (patch.notes === null) delete (next as { notes?: string }).notes;
  else if (patch.notes !== undefined) next.notes = patch.notes;
  if (patch.successCriteria === null) delete (next as { successCriteria?: string }).successCriteria;
  else if (patch.successCriteria !== undefined) next.successCriteria = patch.successCriteria;
  writeCycle(dataDir, next);
  return next;
}

export function deleteHealCycle(dataDir: string, cycleId: string): boolean {
  try {
    rmSync(join(healRoot(dataDir), cycleId), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
