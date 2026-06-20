'use client';

import { useState, type ReactNode } from 'react';
import { cn } from './cn';
import { Sheet } from './sheet';

export interface FilterOption {
  value: string;
  label: string;
}

export interface FilterControl {
  /** Stable id (used for keys and accordion open-state). */
  id: string;
  /** e.g. "State". */
  label: string;
  /** Selected values. Empty array = no filter on this dimension (match all). */
  values: string[];
  /** Concrete options — do NOT include an "All" pseudo-option; empty selection
   *  already means "all". */
  options: FilterOption[];
  onChange: (values: string[]) => void;
}

export interface FilterBarProps {
  /** The search control (caller passes its existing search input). */
  search?: ReactNode;
  /** Structured, multi-select filter controls. */
  filters?: FilterControl[];
  /** Clears every filter (and usually the search). */
  onClearAll?: () => void;
  className?: string;
}

interface ActiveBadge {
  filterId: string;
  filterLabel: string;
  value: string;
  optionLabel: string;
  remove: () => void;
}

function buildBadges(filters: FilterControl[]): ActiveBadge[] {
  const badges: ActiveBadge[] = [];
  for (const f of filters) {
    for (const v of f.values) {
      const opt = f.options.find((o) => o.value === v);
      badges.push({
        filterId: f.id,
        filterLabel: f.label,
        value: v,
        optionLabel: opt?.label ?? v,
        remove: () => f.onChange(f.values.filter((x) => x !== v)),
      });
    }
  }
  return badges;
}

/**
 * Responsive, multi-select filter bar (spec §3.5 / P3).
 *
 *  - A single "Filters" button (with an active count) opens a bottom `Sheet`
 *    containing an accordion: one collapsible section per filter type, each
 *    holding multi-select option rows (checkbox toggles).
 *  - Selected values render as removable badges below the bar on every
 *    breakpoint; tapping a badge clears just that value.
 *
 * Empty `values` on a control means "no filter" — there is no "All" option.
 */
export function FilterBar({ search, filters, onClearAll, className }: FilterBarProps) {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [openSections, setOpenSections] = useState<Set<string>>(new Set());
  const list = filters ?? [];
  const badges = buildBadges(list);
  const activeCount = badges.length;

  const toggleSection = (id: string) =>
    setOpenSections((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const toggleValue = (f: FilterControl, value: string) => {
    f.onChange(
      f.values.includes(value) ? f.values.filter((v) => v !== value) : [...f.values, value],
    );
  };

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {search && <div className="w-full sm:flex-1 sm:min-w-[220px]">{search}</div>}

        {list.length > 0 && (
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-md border border-outline-variant bg-surface px-3 text-sm text-on-surface transition-colors hover:border-primary sm:w-auto"
          >
            <FilterIcon className="h-4 w-4 text-on-surface-variant" />
            Filters
            {activeCount > 0 && (
              <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-on">
                {activeCount}
              </span>
            )}
          </button>
        )}
      </div>

      {/* Selected-filter badges (all breakpoints). */}
      {badges.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {badges.map((b) => (
            <button
              key={`${b.filterId}:${b.value}`}
              type="button"
              onClick={b.remove}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary-container/15 px-2.5 py-1 text-xs text-on-surface transition-colors hover:border-primary"
            >
              <span className="text-on-surface-variant">{b.filterLabel}:</span>
              <span className="font-medium">{b.optionLabel}</span>
              <span aria-hidden className="text-on-surface-variant">
                ×
              </span>
            </button>
          ))}
          {onClearAll && (
            <button
              type="button"
              onClick={onClearAll}
              className="rounded-full px-2 py-1 text-xs text-on-surface-variant underline-offset-2 hover:text-on-surface hover:underline"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Filter accordion sheet. */}
      {list.length > 0 && (
        <Sheet open={sheetOpen} onClose={() => setSheetOpen(false)} side="bottom" title="Filters">
          <div className="flex flex-col px-4 py-2">
            {list.map((f) => {
              const open = openSections.has(f.id);
              return (
                <div key={f.id} className="border-b border-outline-variant last:border-b-0">
                  <button
                    type="button"
                    onClick={() => toggleSection(f.id)}
                    className="flex min-h-12 w-full items-center justify-between gap-2 text-left"
                    aria-expanded={open}
                  >
                    <span className="flex items-center gap-2 font-display text-[13px] font-semibold uppercase tracking-[0.04em] text-on-surface">
                      {f.label}
                      {f.values.length > 0 && (
                        <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-on">
                          {f.values.length}
                        </span>
                      )}
                    </span>
                    <ChevronIcon
                      className={cn(
                        'h-4 w-4 text-on-surface-variant transition-transform',
                        open && 'rotate-180',
                      )}
                    />
                  </button>

                  {open && (
                    <div className="pb-2">
                      {f.options.map((o) => {
                        const checked = f.values.includes(o.value);
                        return (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => toggleValue(f, o.value)}
                            className={cn(
                              'flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-surface-container',
                              checked ? 'text-on-surface' : 'text-on-surface-variant',
                            )}
                            aria-pressed={checked}
                          >
                            <span
                              className={cn(
                                'flex h-5 w-5 shrink-0 items-center justify-center rounded border',
                                checked
                                  ? 'border-primary bg-primary text-primary-on'
                                  : 'border-outline-variant',
                              )}
                            >
                              {checked && <CheckIcon className="h-3.5 w-3.5" />}
                            </span>
                            <span>{o.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="sticky bottom-0 mt-2 flex items-center gap-2 bg-surface-container-high pb-[env(safe-area-inset-bottom)] pt-2">
              {onClearAll && (
                <button
                  type="button"
                  onClick={onClearAll}
                  disabled={activeCount === 0}
                  className="h-11 flex-1 rounded-md border border-outline-variant bg-surface text-sm text-on-surface-variant transition-colors hover:border-primary hover:text-on-surface disabled:opacity-40"
                >
                  Clear all
                </button>
              )}
              <button
                type="button"
                onClick={() => setSheetOpen(false)}
                className="h-11 flex-1 rounded-md bg-primary text-sm font-semibold text-primary-on"
              >
                Done
              </button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}

function FilterIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path d="M3 5h18M6 12h12M10 19h4" strokeLinecap="round" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden
    >
      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={3}
      aria-hidden
    >
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
