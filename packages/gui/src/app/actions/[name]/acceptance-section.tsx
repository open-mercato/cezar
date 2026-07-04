'use client';

import { useMemo } from 'react';
import { cn } from '@/components/ui/cn';
import { SparkleSmallIcon } from '@/components/icons';
import {
  DEFAULT_AUTO_CONFIG,
  DEFAULT_HITL_CONFIG,
  type AcceptanceMode,
  type ActionModel,
  type ConfidenceConfig,
} from './acceptance-types';

interface Props {
  model: ActionModel;
  acceptanceMode: AcceptanceMode;
  confidenceConfig: ConfidenceConfig;
  onChange: (next: {
    model: ActionModel;
    acceptanceMode: AcceptanceMode;
    confidenceConfig: ConfidenceConfig;
  }) => void;
  readOnly: boolean;
}

// ── small sample dataset to power the live preview ──
type SampleFinding = { id: string; issueNumber: number; confidence: number };
const PREVIEW_SAMPLE: SampleFinding[] = [
  { id: 's1', issueNumber: 1395, confidence: 100 },
  { id: 's2', issueNumber: 1402, confidence: 94 },
  { id: 's3', issueNumber: 1410, confidence: 91 },
  { id: 's4', issueNumber: 1410, confidence: 89 },
  { id: 's5', issueNumber: 1402, confidence: 88 },
  { id: 's6', issueNumber: 1421, confidence: 84 },
  { id: 's7', issueNumber: 1438, confidence: 81 },
  { id: 's8', issueNumber: 1410, confidence: 76 },
  { id: 's9', issueNumber: 1421, confidence: 71 },
  { id: 's10', issueNumber: 1457, confidence: 64 },
  { id: 's11', issueNumber: 1460, confidence: 52 },
  { id: 's12', issueNumber: 1471, confidence: 38 },
];

const MODELS: { id: ActionModel; label: string; hint: string }[] = [
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', hint: 'Best judgment · highest cost' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', hint: 'Balanced default' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', hint: 'Fast & cheap · high-volume triage' },
];

export function AcceptanceSection({
  model,
  acceptanceMode,
  confidenceConfig,
  onChange,
  readOnly,
}: Props) {
  // Pull the threshold values out, falling back to the per-mode defaults
  // when the stored shape doesn't match the current mode (e.g. user just
  // toggled modes and the stored config was for the other one).
  const autoAccept =
    'autoAcceptAbove' in confidenceConfig
      ? confidenceConfig.autoAcceptAbove
      : DEFAULT_AUTO_CONFIG.autoAcceptAbove;
  const denyBelow =
    'autoDenyBelow' in confidenceConfig
      ? confidenceConfig.autoDenyBelow
      : DEFAULT_HITL_CONFIG.autoDenyBelow;

  const setMode = (next: AcceptanceMode) => {
    if (next === acceptanceMode) return;
    if (next === 'auto') {
      onChange({ model, acceptanceMode: next, confidenceConfig: { autoAcceptAbove: autoAccept } });
    } else {
      // Pull the previous deny-below if we have it, else default 60 (clamped below autoAccept).
      const low = Math.min(
        'autoDenyBelow' in confidenceConfig
          ? confidenceConfig.autoDenyBelow
          : DEFAULT_HITL_CONFIG.autoDenyBelow,
        autoAccept - 1,
      );
      onChange({
        model,
        acceptanceMode: next,
        confidenceConfig: { autoDenyBelow: Math.max(0, low), autoAcceptAbove: autoAccept },
      });
    }
  };

  const setAutoAccept = (raw: number) => {
    const v = Math.max(0, Math.min(100, Math.round(raw)));
    if (acceptanceMode === 'auto') {
      onChange({ model, acceptanceMode, confidenceConfig: { autoAcceptAbove: v } });
    } else {
      const high = Math.max(v, denyBelow + 1);
      onChange({
        model,
        acceptanceMode,
        confidenceConfig: { autoDenyBelow: denyBelow, autoAcceptAbove: high },
      });
    }
  };

  const setDenyBelow = (raw: number) => {
    const v = Math.max(0, Math.min(100, Math.round(raw)));
    if (acceptanceMode !== 'human-in-the-loop') return;
    const low = Math.min(v, autoAccept - 1);
    onChange({
      model,
      acceptanceMode,
      confidenceConfig: { autoDenyBelow: Math.max(0, low), autoAcceptAbove: autoAccept },
    });
  };

  const setModel = (next: ActionModel) => {
    onChange({ model: next, acceptanceMode, confidenceConfig });
  };

  const buckets = useMemo(() => {
    const accept: SampleFinding[] = [];
    const review: SampleFinding[] = [];
    const deny: SampleFinding[] = [];
    if (acceptanceMode === 'auto') {
      for (const f of PREVIEW_SAMPLE) {
        if (f.confidence >= autoAccept) accept.push(f);
        else deny.push(f);
      }
    } else {
      for (const f of PREVIEW_SAMPLE) {
        if (f.confidence >= autoAccept) accept.push(f);
        else if (f.confidence >= denyBelow) review.push(f);
        else deny.push(f);
      }
    }
    return { accept, review, deny };
  }, [acceptanceMode, autoAccept, denyBelow]);

  return (
    <section className="border-t border-outline-variant bg-surface-container-low">
      <div className="border-b border-outline-variant px-6 py-3">
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
          Model &amp; Acceptance
        </span>
      </div>

      <div className="grid gap-0 lg:grid-cols-2">
        {/* ── Model ── */}
        <div className="border-b border-outline-variant px-6 py-5 lg:border-b-0 lg:border-r">
          <FieldLabel
            title="Model"
            hint="Larger models reason better but cost more per run. Switching is non-destructive."
          />
          <div className="mt-3 grid grid-cols-1 gap-2">
            {MODELS.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setModel(m.id)}
                disabled={readOnly}
                className={cn(
                  'flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
                  model === m.id
                    ? 'border-primary/60 bg-primary/10'
                    : 'border-outline-variant bg-surface hover:border-outline',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                    model === m.id ? 'border-primary bg-primary' : 'border-outline-variant',
                  )}
                >
                  {model === m.id && <span className="h-1.5 w-1.5 rounded-full bg-primary-on" />}
                </span>
                <div className="min-w-0">
                  <div className="text-sm font-medium text-on-surface">{m.label}</div>
                  <div className="text-xs text-on-surface-variant">{m.hint}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* ── Mode ── */}
        <div className="px-6 py-5">
          <FieldLabel title="Acceptance" hint="How findings produced by this action are applied." />
          <div className="mt-3 grid grid-cols-1 gap-2">
            <ModeCard
              active={acceptanceMode === 'auto'}
              onClick={() => setMode('auto')}
              disabled={readOnly}
              title="Auto-accept"
              body="Agent decides 100% by a single confidence cutoff. Nothing reaches the inbox."
            />
            <ModeCard
              active={acceptanceMode === 'human-in-the-loop'}
              onClick={() => setMode('human-in-the-loop')}
              disabled={readOnly}
              title="Human-in-the-loop"
              body="Medium-confidence findings queue to the Inbox. High = auto-accept, low = auto-deny."
            />
          </div>
        </div>
      </div>

      {/* ── Thresholds ── */}
      <div className="border-t border-outline-variant px-6 py-5">
        <FieldLabel
          title="Confidence thresholds"
          hint={
            acceptanceMode === 'auto'
              ? 'Findings at or above the cutoff are accepted; everything else is denied.'
              : 'Drag the handles to set the deny floor and the auto-accept ceiling.'
          }
        />

        <div className="mt-4">
          {acceptanceMode === 'auto' ? (
            <SingleThreshold value={autoAccept} onChange={setAutoAccept} readOnly={readOnly} />
          ) : (
            <DualThreshold
              low={denyBelow}
              high={autoAccept}
              onLow={setDenyBelow}
              onHigh={setAutoAccept}
              readOnly={readOnly}
            />
          )}
        </div>

        {/* ── Live preview ── */}
        <div className="mt-5 rounded-md border border-outline-variant bg-surface px-4 py-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[10.5px] font-medium uppercase tracking-[0.05em] text-on-surface-variant">
              Live preview · {PREVIEW_SAMPLE.length} representative findings
            </span>
            <span className="text-[10.5px] text-outline">
              Reflects how outputs at these thresholds would be routed.
            </span>
          </div>
          <div className="space-y-2">
            <BucketRow
              tone="success"
              label={
                acceptanceMode === 'auto'
                  ? `Accepted (≥ ${autoAccept}%)`
                  : `Auto-accept (≥ ${autoAccept}%)`
              }
              items={buckets.accept}
              total={PREVIEW_SAMPLE.length}
            />
            {acceptanceMode === 'human-in-the-loop' && (
              <BucketRow
                tone="info"
                label={`Human review (${denyBelow}%–${autoAccept - 1}%)`}
                items={buckets.review}
                total={PREVIEW_SAMPLE.length}
              />
            )}
            <BucketRow
              tone="muted"
              label={
                acceptanceMode === 'auto'
                  ? `Denied (< ${autoAccept}%)`
                  : `Auto-deny (< ${denyBelow}%)`
              }
              items={buckets.deny}
              total={PREVIEW_SAMPLE.length}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────
function FieldLabel({ title, hint }: { title: string; hint: string }) {
  return (
    <div>
      <div className="text-sm font-semibold text-on-surface">{title}</div>
      <div className="mt-1 text-xs text-on-surface-variant">{hint}</div>
    </div>
  );
}

function ModeCard({
  active,
  onClick,
  disabled,
  title,
  body,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  title: string;
  body: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60',
        active
          ? 'border-primary/60 bg-primary/10'
          : 'border-outline-variant bg-surface hover:border-outline',
      )}
    >
      <span
        className={cn(
          'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
          active ? 'border-primary bg-primary' : 'border-outline-variant',
        )}
      >
        {active && <span className="h-1.5 w-1.5 rounded-full bg-primary-on" />}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-medium text-on-surface">{title}</div>
        <div className="text-xs text-on-surface-variant">{body}</div>
      </div>
    </button>
  );
}

function SingleThreshold({
  value,
  onChange,
  readOnly,
}: {
  value: number;
  onChange: (v: number) => void;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="relative h-8">
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-surface-container">
          <div
            className="absolute inset-y-0 left-0 bg-outline-variant/50"
            style={{ width: `${value}%` }}
          />
          <div
            className="absolute inset-y-0 bg-emerald-500/40"
            style={{ left: `${value}%`, right: 0 }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={value}
          disabled={readOnly}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-label="Auto-accept threshold"
          className="thresh-slider absolute inset-x-0 top-1/2 z-10 h-8 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
        />
        <SliderStyles />
      </div>
      <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-2">
        <div className="flex items-center justify-between rounded-md border border-outline-variant bg-surface px-3 py-2">
          <span className="text-on-surface-variant">Cutoff</span>
          <NumberPill value={value} onChange={onChange} readOnly={readOnly} />
        </div>
        <div className="flex items-center justify-end gap-1 text-outline">
          <BucketDot tone="success" />
          <span>Auto-accept</span>
          <span className="mx-2">·</span>
          <BucketDot tone="muted" />
          <span>Auto-deny</span>
        </div>
      </div>
    </div>
  );
}

function DualThreshold({
  low,
  high,
  onLow,
  onHigh,
  readOnly,
}: {
  low: number;
  high: number;
  onLow: (v: number) => void;
  onHigh: (v: number) => void;
  readOnly: boolean;
}) {
  return (
    <div className="space-y-2">
      <div className="relative h-8">
        <div className="absolute inset-x-0 top-1/2 h-2 -translate-y-1/2 overflow-hidden rounded-full bg-surface-container">
          <div
            className="absolute inset-y-0 left-0 bg-outline-variant/50"
            style={{ width: `${low}%` }}
          />
          <div
            className="absolute inset-y-0 bg-primary/40"
            style={{ left: `${low}%`, width: `${Math.max(0, high - low)}%` }}
          />
          <div
            className="absolute inset-y-0 bg-emerald-500/40"
            style={{ left: `${high}%`, right: 0 }}
          />
        </div>
        <input
          type="range"
          min={0}
          max={100}
          value={low}
          disabled={readOnly}
          onChange={(e) => onLow(Number(e.target.value))}
          aria-label="Auto-deny below"
          className="thresh-slider absolute inset-x-0 top-1/2 z-10 h-8 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
          style={{ pointerEvents: 'none' }}
        />
        <input
          type="range"
          min={0}
          max={100}
          value={high}
          disabled={readOnly}
          onChange={(e) => onHigh(Number(e.target.value))}
          aria-label="Auto-accept above"
          className="thresh-slider absolute inset-x-0 top-1/2 z-20 h-8 w-full -translate-y-1/2 cursor-pointer appearance-none bg-transparent disabled:cursor-not-allowed disabled:opacity-60"
          style={{ pointerEvents: 'none' }}
        />
        <SliderStyles />
      </div>
      <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
        <ThresholdCell
          tone="muted"
          label="Auto-deny below"
          value={low}
          onChange={onLow}
          readOnly={readOnly}
        />
        <div className="flex items-center justify-center text-outline">
          <BucketDot tone="info" />
          <span className="ml-1.5">
            Human review band:{' '}
            <span className="font-mono text-on-surface">
              {low}%–{Math.max(low, high - 1)}%
            </span>
          </span>
        </div>
        <ThresholdCell
          tone="success"
          label="Auto-accept above"
          value={high}
          onChange={onHigh}
          readOnly={readOnly}
        />
      </div>
    </div>
  );
}

function ThresholdCell({
  tone,
  label,
  value,
  onChange,
  readOnly,
}: {
  tone: 'muted' | 'success';
  label: string;
  value: number;
  onChange: (v: number) => void;
  readOnly: boolean;
}) {
  return (
    <div className="flex items-center justify-between rounded-md border border-outline-variant bg-surface px-3 py-2">
      <span className="flex items-center gap-1.5 text-on-surface-variant">
        <BucketDot tone={tone} />
        {label}
      </span>
      <NumberPill value={value} onChange={onChange} readOnly={readOnly} />
    </div>
  );
}

function NumberPill({
  value,
  onChange,
  readOnly,
}: {
  value: number;
  onChange: (v: number) => void;
  readOnly: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-0.5">
      <input
        type="number"
        inputMode="numeric"
        min={0}
        max={100}
        value={value}
        readOnly={readOnly}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isNaN(n)) return;
          onChange(Math.max(0, Math.min(100, n)));
        }}
        className="w-12 rounded border border-outline-variant bg-surface-container px-1.5 py-0.5 text-right font-mono text-base text-on-surface focus:border-primary focus:outline-none read-only:opacity-70 lg:text-xs"
      />
      <span className="text-outline">%</span>
    </span>
  );
}

function BucketRow({
  tone,
  label,
  items,
  total,
}: {
  tone: 'success' | 'info' | 'muted';
  label: string;
  items: SampleFinding[];
  total: number;
}) {
  const pct = total === 0 ? 0 : (items.length / total) * 100;
  const barClass = {
    success: 'bg-emerald-500/50',
    info: 'bg-primary/40',
    muted: 'bg-outline-variant/50',
  }[tone];
  const labelClass = {
    success: 'text-emerald-300',
    info: 'text-primary',
    muted: 'text-on-surface-variant',
  }[tone];
  return (
    <div className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[200px_1fr_60px] sm:gap-3">
      <div className={cn('flex items-center gap-1.5 text-xs font-medium', labelClass)}>
        <BucketDot tone={tone} />
        {label}
      </div>
      <div className="relative h-6 overflow-hidden rounded-md border border-outline-variant/40 bg-surface-container">
        <div
          className={cn('absolute inset-y-0 left-0 transition-all duration-200', barClass)}
          style={{ width: `${pct}%` }}
        />
        <div className="absolute inset-0 flex items-center gap-1 overflow-hidden px-2">
          {items.slice(0, 6).map((it) => (
            <span
              key={it.id}
              className="truncate rounded bg-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-on-surface-variant"
              title={`#${it.issueNumber} · ${it.confidence}%`}
            >
              <SparkleSmallIcon className="mr-0.5 inline-block h-2.5 w-2.5 align-text-bottom text-outline" />
              #{it.issueNumber} · {it.confidence}%
            </span>
          ))}
          {items.length > 6 && (
            <span className="rounded bg-surface/80 px-1.5 py-0.5 font-mono text-[10px] text-outline">
              +{items.length - 6}
            </span>
          )}
        </div>
      </div>
      <div className="text-right font-mono text-xs text-on-surface">
        {items.length}
        <span className="text-outline">/{total}</span>
      </div>
    </div>
  );
}

function BucketDot({ tone }: { tone: 'success' | 'info' | 'muted' }) {
  const cls = {
    success: 'bg-emerald-400',
    info: 'bg-primary',
    muted: 'bg-outline-variant',
  }[tone];
  return <span className={cn('inline-block h-2 w-2 rounded-full', cls)} />;
}

function SliderStyles() {
  return (
    <style jsx>{`
      :global(.thresh-slider) {
        -webkit-appearance: none;
        appearance: none;
        outline: none;
        pointer-events: none;
      }
      :global(.thresh-slider::-webkit-slider-runnable-track) {
        background: transparent;
        height: 8px;
      }
      :global(.thresh-slider::-moz-range-track) {
        background: transparent;
        height: 8px;
      }
      :global(.thresh-slider::-webkit-slider-thumb) {
        -webkit-appearance: none;
        appearance: none;
        height: 18px;
        width: 18px;
        border-radius: 9999px;
        background: #adc6ff;
        border: 3px solid #10131a;
        box-shadow:
          0 0 0 1px #adc6ff,
          0 2px 6px rgba(0, 0, 0, 0.5);
        cursor: grab;
        margin-top: -5px;
        pointer-events: auto;
      }
      :global(.thresh-slider::-webkit-slider-thumb:active) {
        cursor: grabbing;
      }
      :global(.thresh-slider::-moz-range-thumb) {
        height: 18px;
        width: 18px;
        border-radius: 9999px;
        background: #adc6ff;
        border: 3px solid #10131a;
        box-shadow:
          0 0 0 1px #adc6ff,
          0 2px 6px rgba(0, 0, 0, 0.5);
        cursor: grab;
        pointer-events: auto;
      }
    `}</style>
  );
}
