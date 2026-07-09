'use client';

import { useActionState, useEffect, useState } from 'react';
import { cn } from '@/components/ui/cn';
import { StatusDotIcon } from '@/components/icons';
import { timeAgo } from '@/lib/time-ago';
import {
  mintJoinToken,
  revokeJoinToken,
  revokeRunner,
  type JoinTokenActionState,
  type RunnerActionState,
} from './runners-actions';

export type RunnerDisplayStatus = 'online' | 'stale' | 'offline';

export interface RunnerRowView {
  id: string;
  name: string;
  kind: 'cloud' | 'self-hosted';
  backends: string[];
  displayStatus: RunnerDisplayStatus;
  lastHeartbeatAt: string | null;
  createdAt: string;
  managed: boolean;
  /** GitHub login of the runner's owner; null on legacy pre-join-token rows. */
  ownerLogin: string | null;
  /** True when the current user owns this runner (may revoke it). */
  mine: boolean;
}

export interface JoinTokenView {
  id: string;
  label: string;
  createdByLogin: string;
  createdAt: string;
  revokedAt: string | null;
  /** True when the current user minted this token (may revoke it). */
  mine: boolean;
}

interface RunnersSectionProps {
  ownRunners: RunnerRowView[];
  managedRunners: RunnerRowView[];
  joinTokens: JoinTokenView[];
  isAdmin: boolean;
  appUrl: string;
}

const STATUS_TONE: Record<RunnerDisplayStatus, 'enabled' | 'warning' | 'queued'> = {
  online: 'enabled',
  stale: 'warning',
  offline: 'queued',
};

const STATUS_LABEL_CLASS: Record<RunnerDisplayStatus, string> = {
  online: 'text-emerald-300',
  stale: 'text-tertiary',
  offline: 'text-on-surface-variant',
};

export function RunnersSection({
  ownRunners,
  managedRunners,
  joinTokens,
  isAdmin,
  appUrl,
}: RunnersSectionProps) {
  const [state, formAction, pending] = useActionState<JoinTokenActionState, FormData>(
    mintJoinToken,
    {},
  );

  // Mirror the one-shot token into local state so we can wipe it from memory:
  // useActionState keeps its own result around (and can replay it on a
  // back/forward navigation), so we never render `state.token` directly — we
  // surface a copy that we clear on a timeout or an explicit dismiss.
  const [revealedToken, setRevealedToken] = useState<string | null>(null);
  useEffect(() => {
    if (state.token && state.joinTokenId) setRevealedToken(state.token);
  }, [state.token, state.joinTokenId]);

  return (
    <div className="space-y-6">
      {/* This workspace's runners */}
      <Card
        title="This workspace"
        subtitle={`${ownRunners.length} self-hosted runner${ownRunners.length === 1 ? '' : 's'}`}
      >
        {ownRunners.length === 0 ? (
          <EmptyState body="No self-hosted runners yet. Mint a join token below and start a runner with it — it registers itself." />
        ) : (
          <ul className="divide-y divide-outline-variant/60">
            {ownRunners.map((r) => (
              <RunnerRow key={r.id} runner={r} canRevoke={isAdmin || r.mine} />
            ))}
          </ul>
        )}
      </Card>

      {/* Managed / global runners (read-only) */}
      <Card
        title="Managed — Cezar cloud"
        subtitle="anthropic-api jobs are handled by Cezar's own infrastructure"
      >
        {managedRunners.length === 0 ? (
          <EmptyState body="No managed runners configured. The dispatcher cron handles anthropic-api jobs directly — no self-hosted runner needed." />
        ) : (
          <ul className="divide-y divide-outline-variant/60">
            {managedRunners.map((r) => (
              <RunnerRow key={r.id} runner={r} canRevoke={false} />
            ))}
          </ul>
        )}
      </Card>

      {/* Join tokens — the only way to register a runner */}
      <Card
        title="Join tokens"
        subtitle="A runner registers itself with a join token and belongs to whoever minted it. Tokens are reusable across devices until revoked."
      >
        <div className="space-y-4">
          {revealedToken ? (
            <TokenReveal
              token={revealedToken}
              appUrl={appUrl}
              onDismiss={() => setRevealedToken(null)}
            />
          ) : (
            <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
              {state.error && (
                <div className="rounded-md border border-error/40 bg-error/10 px-3 py-2 text-sm text-error sm:order-last">
                  {state.error}
                </div>
              )}
              <div className="flex-1 sm:max-w-md">
                <label
                  htmlFor="join-token-label"
                  className="mb-1 block text-xs font-medium text-on-surface-variant"
                >
                  Label <span className="text-outline">(optional — e.g. “laptop”, “ci-box”)</span>
                </label>
                <input
                  id="join-token-label"
                  name="label"
                  type="text"
                  maxLength={80}
                  placeholder="What is this token for?"
                  className="h-9 w-full rounded-md border border-outline-variant bg-surface px-3 text-base lg:text-sm text-on-surface placeholder:text-outline focus:border-primary focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={pending}
                className="inline-flex h-9 shrink-0 items-center rounded-md bg-primary px-4 text-sm font-semibold text-primary-on transition-colors hover:bg-primary-container hover:text-on-surface disabled:cursor-not-allowed disabled:opacity-50"
              >
                {pending ? 'Minting…' : 'Mint join token'}
              </button>
            </form>
          )}

          {joinTokens.length > 0 && (
            <ul className="divide-y divide-outline-variant/60">
              {joinTokens.map((t) => (
                <JoinTokenRow key={t.id} token={t} canRevoke={isAdmin || t.mine} />
              ))}
            </ul>
          )}
        </div>
      </Card>
    </div>
  );
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-outline-variant bg-surface-container-low">
      <header className="border-b border-outline-variant/60 px-6 py-4">
        <h2 className="font-display text-[15px] font-semibold tracking-tight text-on-surface">
          {title}
        </h2>
        {subtitle && <p className="mt-1 text-xs text-on-surface-variant">{subtitle}</p>}
      </header>
      <div className="px-6 py-5">{children}</div>
    </section>
  );
}

function EmptyState({ body }: { body: string }) {
  return (
    <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low/40 p-6 text-center text-sm text-on-surface-variant">
      {body}
    </div>
  );
}

function RunnerRow({ runner, canRevoke }: { runner: RunnerRowView; canRevoke: boolean }) {
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 items-start gap-4">
        <StatusDotIcon
          className="mt-0.5 h-3 w-3 shrink-0 sm:mt-0"
          tone={STATUS_TONE[runner.displayStatus]}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm">
            <span className="truncate font-medium text-on-surface">{runner.name}</span>
            <span
              className={cn(
                'font-display text-[10.5px] font-semibold uppercase tracking-wider',
                STATUS_LABEL_CLASS[runner.displayStatus],
              )}
            >
              {runner.displayStatus}
            </span>
            {runner.managed && <span className="font-mono text-[11px] text-outline">managed</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {!runner.managed && (
              <span className="font-mono text-[10.5px] text-on-surface-variant">
                {runner.ownerLogin ? `@${runner.ownerLogin}` : 'unowned (legacy)'}
              </span>
            )}
            {(runner.managed ? ['anthropic-api'] : runner.backends).map((b) => (
              <span
                key={b}
                className="rounded border border-outline-variant bg-surface-container px-1.5 py-0.5 font-mono text-[10.5px] text-on-surface-variant"
              >
                {b}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3 pl-7 sm:pl-0">
        <div className="shrink-0 text-left text-[11px] text-outline sm:text-right">
          <div>heartbeat {timeAgo(runner.lastHeartbeatAt)}</div>
          <div>added {timeAgo(runner.createdAt)}</div>
        </div>
        {canRevoke && !runner.managed && <RevokeButton runnerId={runner.id} name={runner.name} />}
      </div>
    </li>
  );
}

function JoinTokenRow({ token, canRevoke }: { token: JoinTokenView; canRevoke: boolean }) {
  const revoked = token.revokedAt != null;
  return (
    <li className="flex items-center gap-4 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-sm">
          <span className={cn('truncate text-on-surface', revoked && 'line-through opacity-60')}>
            {token.label || 'untitled token'}
          </span>
          {revoked && (
            <span className="font-display text-[10.5px] font-semibold uppercase tracking-wider text-on-surface-variant">
              revoked
            </span>
          )}
        </div>
        <div className="mt-0.5 font-mono text-[10.5px] text-on-surface-variant">
          @{token.createdByLogin}
        </div>
      </div>
      <div className="shrink-0 text-right text-[11px] text-outline">
        minted {timeAgo(token.createdAt)}
      </div>
      {canRevoke && !revoked && <RevokeJoinTokenButton joinTokenId={token.id} />}
    </li>
  );
}

function RevokeButton({ runnerId, name }: { runnerId: string; name: string }) {
  const [state, action, pending] = useActionState<RunnerActionState, FormData>(revokeRunner, {});
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Revoke runner "${name}"? Its token stops working immediately.`))
          e.preventDefault();
      }}
      className="shrink-0"
    >
      <input type="hidden" name="runnerId" value={runnerId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-7 items-center rounded-md border border-outline-variant bg-surface px-2.5 text-xs text-on-surface-variant transition-colors hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
        title={state.error ?? undefined}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
    </form>
  );
}

function RevokeJoinTokenButton({ joinTokenId }: { joinTokenId: string }) {
  const [state, action, pending] = useActionState<JoinTokenActionState, FormData>(
    revokeJoinToken,
    {},
  );
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (
          !confirm(
            'Revoke this join token? It can no longer register runners; already-registered runners keep working.',
          )
        )
          e.preventDefault();
      }}
      className="shrink-0"
    >
      <input type="hidden" name="joinTokenId" value={joinTokenId} />
      <button
        type="submit"
        disabled={pending}
        className="inline-flex h-7 items-center rounded-md border border-outline-variant bg-surface px-2.5 text-xs text-on-surface-variant transition-colors hover:border-error/40 hover:text-error disabled:cursor-not-allowed disabled:opacity-50"
        title={state.error ?? undefined}
      >
        {pending ? 'Revoking…' : 'Revoke'}
      </button>
    </form>
  );
}

// Seconds the one-shot token stays in memory before it auto-clears. Keeps the
// raw credential out of the DOM/React state for longer than necessary.
const TOKEN_AUTO_CLEAR_MS = 60_000;

function TokenReveal({
  token,
  appUrl,
  onDismiss,
}: {
  token: string;
  appUrl: string;
  onDismiss: () => void;
}) {
  const url = appUrl || '<your-cezar-url>';
  const command = `cezar-runner start --url ${url} --join-token ${token}`;
  const [revealed, setRevealed] = useState(false);

  // Auto-clear the token from memory after a short window so it doesn't sit in
  // the DOM/React state for the lifetime of the tab.
  useEffect(() => {
    const t = setTimeout(onDismiss, TOKEN_AUTO_CLEAR_MS);
    return () => clearTimeout(t);
  }, [onDismiss]);

  return (
    <div className="space-y-3 rounded-md border border-primary/40 bg-primary/10 p-4">
      <p className="text-sm text-on-surface">
        Join token minted.{' '}
        <strong className="text-primary">Copy it now — it won&apos;t be shown again.</strong> Start
        a runner with it (backends are auto-detected from the CLIs on that host); in Docker, set{' '}
        <code className="font-mono text-[12px]">CEZAR_RUNNER_JOIN_TOKEN</code> instead.
      </p>
      <CopyBox
        label="Join token"
        value={token}
        secret
        revealed={revealed}
        onToggleReveal={() => setRevealed((v) => !v)}
      />
      <CopyBox label="Start command" value={command} secret revealed={revealed} />
      <p className="text-xs text-on-surface-variant" role="status" aria-live="polite">
        The token hides itself in {TOKEN_AUTO_CLEAR_MS / 1000}s. It is never stored in plaintext —
        only a hash is kept.
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDismiss}
          className="inline-flex h-8 items-center rounded-md border border-outline-variant bg-surface px-3 text-xs text-on-surface-variant transition-colors hover:border-primary/40 hover:text-primary"
        >
          Dismiss &amp; hide
        </button>
      </div>
    </div>
  );
}

function CopyBox({
  label,
  value,
  secret = false,
  revealed = false,
  onToggleReveal,
}: {
  label: string;
  value: string;
  secret?: boolean;
  revealed?: boolean;
  onToggleReveal?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const masked = secret && !revealed;
  const display = masked ? '••••••••••••••••••••••••••••••••' : value;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-on-surface-variant">{label}</span>
        <div className="flex items-center gap-3">
          {secret && onToggleReveal && (
            <button
              type="button"
              onClick={onToggleReveal}
              className="text-xs text-primary hover:underline"
            >
              {revealed ? 'Hide' : 'Reveal'}
            </button>
          )}
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(value).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
            className="inline-flex min-h-11 items-center text-xs text-primary hover:underline lg:min-h-0"
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        </div>
      </div>
      <pre
        className="overflow-x-auto rounded-md border border-outline-variant bg-surface-container-lowest px-3 py-2 font-mono text-xs text-on-surface"
        aria-live="polite"
      >
        {display}
      </pre>
    </div>
  );
}
