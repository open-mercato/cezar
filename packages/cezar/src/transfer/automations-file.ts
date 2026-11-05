import { createHash } from 'node:crypto';
import {
  AUTOMATIONS_FILE_FORMAT,
  AUTOMATIONS_FILE_VERSION,
  schedulesOf,
  type AutomationImportResolutions,
  type AutomationImportRow,
  type AutomationsFile,
  type PortableAutomation,
} from '@open-mercato/cezar-contract';
import { automationDefinitionSchema, type AutomationDefinition } from '../automations/types.ts';
import {
  automationEditableSchema,
  automationInputIssue,
  oncePassedIssue,
  type AutomationInputChecks,
} from '../automations/validate-input.ts';

/**
 * The automations file (spec 2026-11-04-automations-and-config-export-import, Phase 1): export
 * strips everything but the editable definition; the planner turns a file plus the user's
 * resolutions into preview rows, the writes those rows mean, and a digest apply re-checks.
 */

type StoredInput = Omit<AutomationDefinition, 'id' | 'revision' | 'createdAt' | 'updatedAt'>;

/** The editable keys a file carries — every other definition key stays on this machine. */
function portable(definition: AutomationDefinition): PortableAutomation {
  const row: Record<string, unknown> = {
    name: definition.name,
    description: definition.description,
    kind: definition.kind,
    events: definition.events,
    intervalSeconds: definition.intervalSeconds,
    filters: definition.filters,
    trackerTrigger: definition.trackerTrigger,
    schedule: definition.schedule,
    schedules: definition.schedules,
    task: definition.task,
  };
  for (const key of Object.keys(row)) if (row[key] === undefined) delete row[key];
  return JSON.parse(JSON.stringify(row)) as PortableAutomation;
}

/** Composer starts (`deferredStart`) are one-off task launches, not automations: never exported. */
export function exportAutomations(
  definitions: AutomationDefinition[],
  options: { ids?: string[]; now?: Date; cezarVersion?: string } = {},
): AutomationsFile {
  const wanted = options.ids?.length ? new Set(options.ids) : undefined;
  return {
    format: AUTOMATIONS_FILE_FORMAT,
    version: AUTOMATIONS_FILE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    ...(options.cezarVersion ? { cezarVersion: options.cezarVersion } : {}),
    automations: definitions
      .filter((definition) => !definition.deferredStart && (!wanted || wanted.has(definition.id)))
      .map(portable),
  };
}

export function runsCommands(row: { task: { steps?: Array<{ command?: string }> } }): boolean {
  return !!row.task.steps?.some((step) => typeof step.command === 'string');
}

const key = (name: string) => name.trim().toLocaleLowerCase();

function uniqueName(base: string, taken: Set<string>): string {
  let candidate = `${base} (imported)`;
  for (let n = 2; taken.has(key(candidate)); n++) candidate = `${base} (imported ${n})`;
  return candidate;
}

/** Stable JSON: object keys sorted, so the digest never depends on key order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export interface AutomationImportPlan {
  rows: AutomationImportRow[];
  planDigest: string;
  creates: StoredInput[];
  replaces: Array<{ id: string; expectedRevision: number; input: StoredInput }>;
}

export interface PlanOptions {
  /** `capabilities().localHandoff`: command-bearing rows import only on a local cockpit. */
  localHandoff: boolean;
  checks: AutomationInputChecks;
}

/**
 * Pure apart from the injected checks. Collisions are by name (case-insensitive) against the
 * target AND the file's earlier rows; an unresolved collision defaults to skip, never overwrite.
 */
export async function planAutomationImport(
  file: AutomationsFile,
  resolutions: AutomationImportResolutions | undefined,
  existing: AutomationDefinition[],
  options: PlanOptions,
): Promise<AutomationImportPlan> {
  const live = existing.filter((definition) => !definition.deferredStart);
  const byName = new Map(live.map((definition) => [key(definition.name), definition] as const));
  const taken = new Set(byName.keys());
  const fileNames = new Map<string, number>();
  const replacedTargets = new Set<string>();
  const rows: AutomationImportRow[] = [];
  const creates: StoredInput[] = [];
  const replaces: AutomationImportPlan['replaces'] = [];

  for (const [index, source] of file.automations.entries()) {
    const resolution = resolutions?.[String(index)];
    const kind = source.kind ?? 'github';
    const name = source.name.trim();
    const existingMatch = byName.get(key(name));
    const fileMatch = fileNames.get(key(name));
    const collision = existingMatch
      ? { id: existingMatch.id, name: existingMatch.name }
      : fileMatch !== undefined ? { name: file.automations[fileMatch]!.name } : undefined;
    const issues: string[] = [];
    let action: AutomationImportRow['action'] = collision ? 'skip' : 'create';
    let landedName = name;
    let target: AutomationDefinition | undefined;

    if (resolution?.action === 'skip') action = 'skip';
    else if (resolution?.action === 'rename') {
      action = 'rename';
      landedName = resolution.newName?.trim() || uniqueName(name, taken);
      if (taken.has(key(landedName))) issues.push(`the name "${landedName}" is already taken`);
    } else if (resolution?.action === 'replace') {
      action = 'replace';
      if (!existingMatch) issues.push('there is no automation with this name to replace');
      else if (replacedTargets.has(existingMatch.id)) issues.push(`another row already replaces "${existingMatch.name}"`);
      else target = existingMatch;
    }

    const commands = runsCommands(source);
    const task = { ...source.task };
    if (resolution?.useDefaultAccount) delete task.agentProfile;
    const body = { ...source, name: landedName, kind, task };
    const warnings: string[] = [];

    if (action !== 'skip') {
      if (commands && !options.localHandoff) issues.push('runs shell commands — import it from a local cockpit');
      else if (commands && !resolution?.acceptCommands) issues.push('runs shell commands — acknowledge them to import this row');
      const editable = automationEditableSchema.safeParse(body);
      if (!editable.success) {
        issues.push(...editable.error.issues.map((issue) => (issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message)));
      } else {
        const inputIssue = await automationInputIssue(editable.data, kind, false, options.checks);
        if (inputIssue) issues.push(inputIssue);
        const stored = automationDefinitionSchema.safeParse({
          ...editable.data, enabled: false, id: 'import-check', revision: 1, createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(),
        });
        if (!stored.success) issues.push(...stored.error.issues.map((issue) => issue.message));
        if (oncePassedIssue(schedulesOf(editable.data)[0], true)) warnings.push('the one-time schedule is in the past — it will not fire until rescheduled');
        if (!issues.length) {
          const input = { ...editable.data, kind, enabled: false } as StoredInput;
          if (action === 'replace' && target) replaces.push({ id: target.id, expectedRevision: target.revision, input });
          else creates.push(input);
        }
      }
      if (action === 'replace' && target) replacedTargets.add(target.id);
      else taken.add(key(landedName));
    }
    if (action !== 'skip' && action !== 'replace') fileNames.set(key(landedName), index);

    rows.push({
      index,
      name,
      kind,
      action,
      ...(target ? { target: target.id } : {}),
      ...(action === 'rename' ? { newName: landedName } : {}),
      ...(collision ? { collision } : {}),
      issues,
      warnings,
      runsCommands: commands,
    });
  }

  const planDigest = digestOf({
    file,
    resolutions: resolutions ?? {},
    localHandoff: options.localHandoff,
    target: live.map((definition) => [definition.id, definition.revision, definition.name]).sort(),
  });
  return { rows, planDigest, creates, replaces };
}
