import { loadWorkspaceConfig } from './workspace/config.ts';
import {
  DEFAULT_TELEMETRY_URL,
  TELEMETRY_EVENTS,
  loadTelemetryConsent,
  setTelemetryConsent,
  telemetryBlockedBy,
  telemetryEnvelope,
} from './telemetry.ts';

/**
 * `cezar telemetry` — the terminal twin of Settings → Privacy, and the only way to answer on a
 * headless box (which, unanswered, sends nothing). Works on `~/.cezar/config.json` directly, so
 * no server needs to run; a running one sees the change on its next send.
 */

export interface TelemetryCommandIo {
  log: (line: string) => void;
  error: (line: string) => void;
}

const defaultIo: TelemetryCommandIo = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

const USAGE = `usage:
  cezar telemetry [status]   show whether usage data is shared
  cezar telemetry enable     share usage data (opt in)
  cezar telemetry disable    stop sharing and delete the install id
  cezar telemetry inspect    print what an event would carry, without sending it`;

const BLOCKED: Record<'env' | 'automation', string> = {
  env: 'blocked by CEZ_TELEMETRY=0 or DO_NOT_TRACK=1 — nothing is sent whatever the answer',
  automation: 'not sent from CI, test runners or CEZ_DRY_RUN=1',
};

export async function runTelemetryCommand(args: string[], io: TelemetryCommandIo = defaultIo): Promise<number> {
  const [sub = 'status'] = args;
  const endpoint = (process.env.CEZ_TELEMETRY_URL || DEFAULT_TELEMETRY_URL).replace(/\/+$/, '');
  switch (sub) {
    case 'status': {
      const consent = await loadTelemetryConsent();
      const blocked = telemetryBlockedBy();
      io.log(`telemetry: ${consent === 'granted' ? 'on' : consent === 'denied' ? 'off' : 'off (never asked)'}`);
      if (blocked) io.log(`  ${BLOCKED[blocked]}`);
      io.log(`  endpoint: ${endpoint}`);
      return 0;
    }
    case 'enable':
      await setTelemetryConsent('granted');
      io.log('telemetry: on — thank you. `cezar telemetry disable` turns it off at any time.');
      if (telemetryBlockedBy() === 'env') io.log(`  note: ${BLOCKED.env}`);
      return 0;
    case 'disable':
      await setTelemetryConsent('denied');
      io.log('telemetry: off — nothing more is sent, and the install id was deleted.');
      return 0;
    case 'inspect': {
      const consent = await loadTelemetryConsent();
      const { cezarId } = await loadWorkspaceConfig();
      io.log(`telemetry: ${consent}${telemetryBlockedBy() ? ` (${telemetryBlockedBy()})` : ''} — nothing was sent by this command`);
      io.log(`POST ${endpoint}/track/<event>`);
      io.log(JSON.stringify({ ...telemetryEnvelope(), indexKey: cezarId ?? '<created on the first send>' }, null, 2));
      io.log(`events: ${TELEMETRY_EVENTS.join(', ')}`);
      io.log('each may add a `label` from a closed set; see docs/telemetry.md');
      return 0;
    }
    default:
      io.error(USAGE);
      return 1;
  }
}
