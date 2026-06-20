'use client';

import { type ReactNode } from 'react';
import { cn } from './cn';

/**
 * Responsive table↔card building blocks (spec §3.5 / P1).
 *
 * The six entity tables (Issues, PRs, Cockpit runs, Runners, Team, Actions/
 * Skills) differ too much for one rigid column-config table. So this file
 * provides flexible building blocks rather than an abstraction:
 *
 *   <ResponsiveListContainer
 *     table={<table>…</table>}   // shown at md+
 *     cards={rows.map(r => <EntityCard …/>)}  // shown < md
 *   />
 *
 * or, equivalently, use the documented convention directly:
 *   <div className="hidden md:block">…table…</div>
 *   <div className="md:hidden space-y-3">…cards…</div>
 *
 * An `<EntityCard>` is the per-row card: a title row (primary id + optional
 * status/badge slot), wrapping key/value `MetaRow`/`MetaItem` lines, and a
 * `CardActions` slot for the kebab/buttons. Adoption per screen lands in
 * Phase 2.
 */

export interface ResponsiveListContainerProps {
  /** Tabular view — shown at `md+`. */
  table: ReactNode;
  /** Card list — shown `< md`. */
  cards: ReactNode;
  className?: string;
}

export function ResponsiveListContainer({ table, cards, className }: ResponsiveListContainerProps) {
  return (
    <div className={className}>
      <div className="hidden md:block">{table}</div>
      <div className="space-y-3 md:hidden">{cards}</div>
    </div>
  );
}

export interface EntityCardProps {
  /** Primary identifier line (e.g. `#42 — Title`). */
  title: ReactNode;
  /** Optional leading slot (e.g. run-status dot / avatar). */
  leading?: ReactNode;
  /** Optional status badge / pill rendered at the end of the title row. */
  badge?: ReactNode;
  /** Meta lines (use `MetaRow` + `MetaItem`). */
  children?: ReactNode;
  /** Actions row (use `CardActions`), rendered at the bottom. */
  actions?: ReactNode;
  /** When set, wraps the title row in this href (caller decides Link vs <a>). */
  className?: string;
}

export function EntityCard({
  title,
  leading,
  badge,
  children,
  actions,
  className,
}: EntityCardProps) {
  return (
    <div
      className={cn(
        'rounded-lg border border-outline-variant bg-surface-container-low p-3',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {leading && <div className="shrink-0 pt-0.5">{leading}</div>}
        <div className="min-w-0 flex-1 text-sm font-medium text-on-surface">{title}</div>
        {badge && <div className="shrink-0">{badge}</div>}
      </div>
      {children && <div className="mt-2 space-y-1">{children}</div>}
      {actions && <div className="mt-3">{actions}</div>}
    </div>
  );
}

/** A wrapping row of meta items (key/value pairs). */
export function MetaRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>{children}</div>
  );
}

/** A single key/value meta item. Label is optional (omit for a bare chip). */
export function MetaItem({
  label,
  children,
  className,
}: {
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs text-on-surface-variant', className)}
    >
      {label && (
        <span className="font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-outline">
          {label}
        </span>
      )}
      <span className="text-on-surface">{children}</span>
    </span>
  );
}

/** Actions slot — wraps + right-aligns, full-width-friendly on phone. */
export function CardActions({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-center justify-end gap-2', className)}>{children}</div>
  );
}
