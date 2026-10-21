/**
 * `cezar alerts test` — send one test alert to every configured gateway target
 * (`CEZ_OPENCLAW_*`, `CEZ_HERMES_*`) and say what each answered. Honors `CEZ_DRY_RUN=1` (prints
 * the request instead of sending it).
 */
import {
  alertConfigFromEnv,
  alertsConfigured,
  defaultAlertDeps,
  sendAlert,
  type Alert,
  type AlertDeps,
} from './alerts.ts';

export async function runAlertsCommand(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  deps: AlertDeps = { ...defaultAlertDeps(env), log: console.log },
  io: { log: (line: string) => void; error: (line: string) => void } = { log: console.log, error: console.error },
): Promise<number> {
  if (args[0] !== 'test') {
    io.error('cezar alerts test — send a test alert to the OpenClaw / Hermes targets set in the environment');
    return args[0] === undefined || args[0] === '--help' ? 0 : 2;
  }
  const config = alertConfigFromEnv(env);
  for (const warning of config.warnings) io.error(`cezar alerts: ${warning}`);
  if (!alertsConfigured(config)) {
    io.error('cezar alerts: no target configured — set CEZ_OPENCLAW_URL + CEZ_OPENCLAW_HOOK_TOKEN and/or CEZ_HERMES_WEBHOOK_URL + CEZ_HERMES_WEBHOOK_SECRET (see: cezar integrations print <hermes|openclaw>)');
    return 2;
  }
  const alert: Alert = {
    event: 'needs-input',
    at: deps.now(),
    task: {
      id: 'test0000-0000-0000-0000-000000000000',
      title: 'Test alert from cezar',
      status: 'waiting',
      project: 'test',
      question: 'Is this alert reaching you? [yes / no]',
    },
  };
  const results = await sendAlert(config, alert, deps);
  for (const result of results) io.log(`${result.target}: ${result.ok ? 'ok' : 'FAILED'} (${result.detail})`);
  return results.every((result) => result.ok) ? 0 : 1;
}
