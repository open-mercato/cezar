'use client';

import { useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { cn } from '@/components/ui/cn';
import { PageContainer } from '@/components/ui/page-container';
import { SparkleIcon, BoltIcon, TerminalIcon, RefreshIcon } from '@/components/icons';

// ─────────────────────────────────────────────────────────────────────
// Settings tab shell. Matches the inbox / actions / issues page chrome:
// page header (h1 + meta + role badge), then a tab bar, then the active
// tab's content as cards on M3 tokens. No long scrolling stack any more.
// ─────────────────────────────────────────────────────────────────────

export interface SettingsTabsProps {
  workspace: {
    name: string;
    repoOwner: string;
    repoName: string;
    role: 'admin' | 'actor' | 'viewer';
  };
  automation: ReactNode;
  labels: ReactNode;
  team: ReactNode;
  configuration: ReactNode;
}

type TabId = 'general' | 'automation' | 'labels' | 'team' | 'configuration';

const TABS: { id: TabId; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'automation', label: 'Automation' },
  { id: 'labels', label: 'Labels' },
  { id: 'team', label: 'Team' },
  { id: 'configuration', label: 'Configuration' },
];

export function SettingsTabs({
  workspace,
  automation,
  labels,
  team,
  configuration,
}: SettingsTabsProps) {
  const [active, setActive] = useState<TabId>('general');
  const roleLabel = useMemo(() => workspace.role.toUpperCase(), [workspace.role]);

  return (
    <PageContainer max="max-w-[1080px]">
      {/* ── Page header (matches /inbox + /issues style) ── */}
      <header className="mb-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="font-display text-xl font-semibold leading-tight tracking-tight text-on-surface sm:text-2xl lg:text-[28px]">
              Settings
            </h1>
            <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
              <span className="font-mono text-on-surface">
                {workspace.repoOwner}/{workspace.repoName}
              </span>
              <span className="text-outline">·</span>
              <RoleBadge role={workspace.role}>{roleLabel}</RoleBadge>
              {workspace.role !== 'admin' && (
                <span className="text-xs text-outline">read-only — admin required to edit</span>
              )}
            </p>
          </div>
        </div>
      </header>

      {/* ── Tab bar (sticky, horizontally scrollable on phone) ── */}
      <div className="sticky top-0 z-sticky mb-6 -mx-4 border-b border-outline-variant bg-surface px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
        <nav
          className="flex items-center gap-1 overflow-x-auto whitespace-nowrap [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          aria-label="Settings sections"
        >
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActive(tab.id)}
              className={cn(
                'inline-flex min-h-11 shrink-0 items-center rounded-md px-3 py-1.5 text-sm transition-colors lg:min-h-0',
                active === tab.id
                  ? 'bg-primary/10 text-primary'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
              )}
              aria-current={active === tab.id ? 'page' : undefined}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* ── Active tab content ── */}
      <div>
        {active === 'general' && <GeneralTab />}
        {active === 'automation' && automation}
        {active === 'labels' && labels}
        {active === 'team' && team}
        {active === 'configuration' && configuration}
      </div>
    </PageContainer>
  );
}

function GeneralTab() {
  // The "General" tab gathers the cross-page jump-offs that used to live
  // at the top of the long Settings scroll (Skills, Actions, Runners).
  // Keeping them here means they're discoverable from one place without
  // cluttering tabs that have their own real content.
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <QuickLink
        href="/skills"
        title="Skills"
        body="Manage reusable skill prompts that get injected into action runs."
        icon={<SparkleIcon className="h-4 w-4" />}
      />
      <QuickLink
        href="/actions"
        title="Actions"
        body="The cockpit of configurable AI actions per workspace."
        icon={<BoltIcon className="h-4 w-4" />}
      />
      <QuickLink
        href="/settings/runners"
        title="Runners"
        body="Register self-hosted claude-cli / codex-cli runners and view their status."
        icon={<TerminalIcon className="h-4 w-4" />}
      />
      <QuickLink
        href="/cockpit"
        title="Recent runs"
        body="Live agent activity — autofix, CI follow-up, triage."
        icon={<RefreshIcon className="h-4 w-4" />}
      />
    </div>
  );
}

function QuickLink({
  href,
  title,
  body,
  icon,
}: {
  href: string;
  title: string;
  body: string;
  icon: ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group rounded-lg border border-outline-variant bg-surface-container-low p-4 transition-colors hover:border-outline"
    >
      <div className="mb-2 flex items-center gap-2 text-on-surface">
        <span className="text-primary">{icon}</span>
        <span className="text-sm font-medium">{title}</span>
        <span className="ml-auto text-on-surface-variant transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </div>
      <p className="text-xs leading-relaxed text-on-surface-variant">{body}</p>
    </Link>
  );
}

function RoleBadge({
  role,
  children,
}: {
  role: 'admin' | 'actor' | 'viewer';
  children: ReactNode;
}) {
  const tone =
    role === 'admin'
      ? 'border-primary/40 bg-primary/10 text-primary'
      : role === 'actor'
        ? 'border-tertiary/40 bg-tertiary/10 text-tertiary'
        : 'border-outline-variant bg-surface-container text-on-surface-variant';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 font-display text-[10.5px] font-semibold uppercase tracking-[0.05em]',
        tone,
      )}
    >
      {children}
    </span>
  );
}

// Shared "section card" the sub-tabs use to wrap their forms — keeps
// the chrome consistent without forcing each section to duplicate the
// padding/border classes.
export function SettingsCard({
  title,
  description,
  children,
  footer,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-low">
      {(title || description) && (
        <header className="border-b border-outline-variant/60 p-4 lg:px-6 lg:py-4">
          {title && (
            <h2 className="font-display text-[15px] font-semibold tracking-tight text-on-surface">
              {title}
            </h2>
          )}
          {description && <p className="mt-1 text-sm text-on-surface-variant">{description}</p>}
        </header>
      )}
      <div className="p-4 lg:px-6 lg:py-5">{children}</div>
      {footer && (
        <footer className="border-t border-outline-variant/60 bg-surface-container/40 p-4 lg:px-6 lg:py-3">
          {footer}
        </footer>
      )}
    </section>
  );
}

/** Small caps section sublabel used inside cards (Sync / Autofix / Models / …) */
export function SettingsSubsection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-outline-variant/40 pt-6 first:border-t-0 first:pt-0">
      <h3 className="mb-4 font-display text-[11px] font-semibold uppercase tracking-[0.05em] text-on-surface-variant">
        {title}
      </h3>
      {children}
    </div>
  );
}
