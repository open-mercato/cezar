'use client';

import { useState } from 'react';
import { ACTION_GROUP_LABELS, ACTION_TILES, type ActionGroup, type ActionTile } from '@/data/actions';
import { startAction } from '@/app/dashboard/actions';
import type { ActionBadge } from '@/lib/badges';
import { RunDrawer } from './run-drawer';
import { cn } from './ui/cn';

const GROUP_ORDER: ActionGroup[] = ['triage', 'intelligence', 'community'];
const EXCLUDED_FROM_RUN = new Set(['autofix', 'contributor-welcome']);

interface ActionGridProps {
  badges?: Record<string, ActionBadge>;
}

export function ActionGrid({ badges }: ActionGridProps) {
  const [activeRun, setActiveRun] = useState<{ runId: string; actionId: string; label: string } | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  async function handleRun(tile: ActionTile) {
    const result = await startAction(tile.id);
    if (result.ok && result.runId) {
      setActiveRun({ runId: result.runId, actionId: tile.id, label: tile.label });
      setDrawerOpen(true);
    }
  }

  return (
    <>
      <div className="flex flex-col gap-8">
        {GROUP_ORDER.map((group) => {
          const tiles = ACTION_TILES.filter((t) => t.group === group);
          if (tiles.length === 0) return null;
          return (
            <section key={group}>
              <h2 className="mb-3 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                {ACTION_GROUP_LABELS[group]}
              </h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
                {tiles.map((tile) => (
                  <ActionTileCard
                    key={tile.id}
                    tile={tile}
                    badge={badges?.[tile.id]}
                    isRunning={activeRun?.actionId === tile.id}
                    onRun={() => handleRun(tile)}
                    onViewLogs={() => {
                      if (activeRun?.actionId === tile.id) setDrawerOpen(true);
                    }}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>

      {activeRun && drawerOpen && (
        <RunDrawer
          runId={activeRun.runId}
          actionLabel={activeRun.label}
          onClose={() => setDrawerOpen(false)}
        />
      )}
    </>
  );
}

function ActionTileCard({
  tile,
  badge,
  isRunning,
  onRun,
  onViewLogs,
}: {
  tile: ActionTile;
  badge?: ActionBadge;
  isRunning: boolean;
  onRun: () => void;
  onViewLogs: () => void;
}) {
  const unavailable = badge ? (badge.available !== true ? String(badge.available) : null) : null;
  const showRun = !EXCLUDED_FROM_RUN.has(tile.id);

  return (
    <div
      className={cn(
        'group relative flex flex-col gap-2 rounded-lg border border-border bg-bg-elevated p-4 transition-colors hover:border-accent/40',
        tile.flag === 'headline' && 'border-accent/30',
        isRunning && 'border-accent/60',
      )}
    >
      <div className="flex items-center justify-between">
        <span className="text-xl" aria-hidden>{tile.icon}</span>
        <div className="flex items-center gap-1.5">
          {tile.flag && (
            <span className="rounded-full border border-border bg-bg-subtle px-2 py-0.5 text-xs uppercase tracking-wider text-fg-muted">
              {tile.flag}
            </span>
          )}
          {showRun && !isRunning && (
            <button
              onClick={onRun}
              disabled={!!unavailable}
              title={unavailable ?? undefined}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                unavailable
                  ? 'cursor-not-allowed border border-border bg-bg-subtle text-fg-subtle'
                  : 'bg-accent text-bg hover:bg-accent-hover',
              )}
            >
              Run
            </button>
          )}
          {isRunning && (
            <button
              onClick={onViewLogs}
              className="flex items-center gap-1 rounded-md bg-accent/20 px-2.5 py-1 text-xs font-medium text-accent"
            >
              <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
              Running...
            </button>
          )}
        </div>
      </div>
      <div className="text-sm font-medium text-fg">{tile.label}</div>
      <div className="text-xs leading-snug text-fg-muted">{tile.description}</div>
      {badge ? (
        <div className={cn(
          'mt-1 text-xs',
          unavailable ? 'text-fg-subtle' : badge.badge === 'up to date' || badge.badge === 'nothing to fix'
            ? 'text-fg-subtle'
            : 'text-accent',
        )}>
          {unavailable ? unavailable : badge.badge}
        </div>
      ) : (
        <div className="mt-1 text-xs text-fg-subtle">no store loaded</div>
      )}
    </div>
  );
}
