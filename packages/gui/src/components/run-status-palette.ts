import type { RunStatus } from '@/lib/action-runs-loader';

// ─────────────────────────────────────────────────────────────────────
// Single source of truth for the run-status semantic palette.
//
// Every place that renders a RunStatus colour (the dots/tooltips in
// run-status-dots.tsx, the status chip, and the SVG StatusDotIcon) reads
// from here so the same logical status looks identical across the UI and
// theme tweaks only need to happen once.
//
//   dot — Tailwind bg-* class for the solid status dot
//   chip — Tailwind border/bg/text classes for the status chip
//   hex — literal colour for the SVG <circle fill>, which can't take a
//         Tailwind class. Kept in sync with `dot` above.
// ─────────────────────────────────────────────────────────────────────
export interface RunStatusStyle {
  dot: string;
  chip: string;
  hex: string;
}

export const RUN_STATUS_PALETTE: Record<RunStatus, RunStatusStyle> = {
  queued: {
    dot: 'bg-[#8c909f]',
    chip: 'border-outline-variant bg-surface-container text-on-surface-variant',
    hex: '#8c909f',
  },
  running: {
    dot: 'bg-[#60a5fa]',
    chip: 'border-primary/40 bg-primary/10 text-primary',
    hex: '#60a5fa',
  },
  paused: {
    dot: 'bg-[#ffb786]',
    chip: 'border-tertiary/40 bg-tertiary/10 text-tertiary',
    hex: '#ffb786',
  },
  succeeded: {
    dot: 'bg-[#22c55e]',
    chip: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
    hex: '#22c55e',
  },
  failed: {
    dot: 'bg-[#ffb4ab]',
    chip: 'border-error/40 bg-error/10 text-error',
    hex: '#ffb4ab',
  },
  skipped: {
    dot: 'bg-[#525866]',
    chip: 'border-outline-variant bg-surface-container text-outline',
    hex: '#525866',
  },
};
