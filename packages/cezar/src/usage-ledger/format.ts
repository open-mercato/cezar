import { formatPlanPp as pp, type PlanUsageReport, type PlanUsageWindow } from '@open-mercato/cezar-contract';

function clock(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', ...(timeZone ? { timeZone } : {}) });
}
function day(iso: string, timeZone?: string): string {
  const date = new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', ...(timeZone ? { timeZone } : {}) });
  return `${date} ${clock(iso, timeZone)}`;
}
function inLeft(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d${h % 24}h`;
}

/** `cez usage` without `--json`: the same report, every number spelled by `formatPlanPp`. */
export function formatWindow(w: PlanUsageWindow, now: number, timeZone?: string): string[] {
  const kind = w.kind === 'weekly' ? 'weekly window' : '5-hour window';
  const resets = w.current ? ` (resets in ${inLeft(Date.parse(w.resetsAt) - now)})` : ' (ended)';
  const used = w.usedPercent ? ` · ${pp(w.usedPercent.last)}% used` : ' · no reading';
  // A weekly window spans days: name them, or "00:00–00:00" says nothing (QA F6).
  const span = w.kind === 'weekly'
    ? `${day(w.startsAt, timeZone)} – ${day(w.resetsAt, timeZone)}`
    : `${clock(w.startsAt, timeZone)}–${clock(w.resetsAt, timeZone)}`;
  const lines = [`${w.account.label} · ${kind} ${span}${resets}${used}  [${w.id}]`];
  for (const c of w.consumers) {
    const extra: string[] = [];
    if (c.kind === 'manager' && c.parts) extra.push(`(chat ${pp(c.parts.chat)}, watch ${pp(c.parts.watch)}, job ${pp(c.parts.job)})`);
    if (c.aloneInferredPp > 0) extra.push(`alone ${pp(c.aloneInferredPp)}%`);
    if (c.retryWasteEstimatePp > 0) extra.push(`failed attempt ≈${pp(c.retryWasteEstimatePp)}%`);
    lines.push(`  ≈${pp(c.estimatePp)}%  ${c.title}${extra.length ? `  ${extra.join('  ')}` : ''}`);
  }
  if (w.unsplitPp > 0) lines.push(`  ${pp(w.unsplitPp)}%  couldn't be split`);
  if (w.outsideCezarPp > 0) lines.push(`  ${pp(w.outsideCezarPp)}%  outside cezar`);
  if (w.beforeTrackingPp > 0) lines.push(`  ${pp(w.beforeTrackingPp)}%  before cezar's first reading`);
  if (w.untrackedPp > 0) {
    const gaps = w.trackingGaps.map((g) => `${clock(g.from, timeZone)}–${g.to ? clock(g.to, timeZone) : 'now'} ${g.reason === 'tracking-off' ? 'tracking off' : 'nothing recorded until cezar started recording'}`);
    lines.push(`  ${pp(w.untrackedPp)}%  not tracked${gaps.length ? ` (${gaps.join('; ')})` : ''}`);
  }
  if (w.correctionPp > 0) lines.push(`  -${pp(w.correctionPp)}%  provider correction`);
  if (w.readings.length < 2) lines.push('  (one reading so far: nothing to split yet)');
  return lines;
}

export function formatPlanUsageReport(report: PlanUsageReport, now = Date.parse(report.generatedAt), timeZone?: string): string {
  const out: string[] = [];
  if (!report.tracking.enabled) out.push(`Plan-limit tracking is off: ${report.tracking.reason ?? ''}`.trim());
  if (report.windows.length === 0) {
    out.push(report.accounts.length === 0
      ? 'No plan-limit readings yet. Claude (Pro/Max login) and Codex (ChatGPT login) report them while a task or manager runs.'
      : 'No matching window. Try --window all or --window previous.');
  }
  for (const w of report.windows) out.push(...formatWindow(w, now, timeZone), '');
  if (report.windows.length > 0) out.push('≈ = split by cost while several ran at once; your own sessions on the account are not excluded');
  if (report.hints.length > 0) {
    out.push('', 'Worth a look:');
    for (const hint of report.hints) out.push(`  • ${hint.text}`);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
