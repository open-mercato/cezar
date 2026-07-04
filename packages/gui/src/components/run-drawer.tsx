'use client';

import { useEffect, useRef, useState } from 'react';
import { createSupabaseBrowserClient } from '@/lib/supabase/browser';
import { cn } from './ui/cn';
import { Sheet } from './ui/sheet';

interface LogEntry {
  stage: string;
  message: string;
  current?: number;
  total?: number;
  ts: number;
}

interface RunDrawerProps {
  runId: string;
  actionLabel: string;
  onClose: () => void;
}

export function RunDrawer({ runId, actionLabel, onClose }: RunDrawerProps) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [status, setStatus] = useState<'running' | 'done' | 'error'>('running');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    const channel = supabase.channel(runId);

    channel.on('broadcast', { event: 'progress' }, (msg) => {
      const p = msg.payload as LogEntry & { stage: string };
      setLogs((prev) => [...prev, { ...p, ts: Date.now() }]);
      if (p.stage === 'done') setStatus('done');
      if (p.stage === 'error') setStatus('error');
      if (p.stage === 'done' || p.stage === 'error') {
        setTimeout(() => window.location.reload(), 2000);
      }
    });

    channel.subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [runId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  const lastProgress = [...logs].reverse().find((l) => l.total && l.current != null);

  return (
    <Sheet
      open
      onClose={onClose}
      side="right"
      // The Sheet body is itself the scroll region; we want the log list to
      // scroll while the progress bar/footer stay pinned, so we lay out a full
      // flex column inside it and disable the body's own padding.
      className="flex flex-col p-0"
      title={
        <div className="flex flex-col">
          <span className="text-sm font-semibold text-fg">{actionLabel}</span>
          <span className="mt-0.5 flex items-center gap-2 font-normal">
            <StatusIndicator status={status} />
            {lastProgress?.total && lastProgress.current != null && (
              <span className="text-xs text-fg-subtle">
                {lastProgress.current}/{lastProgress.total}
              </span>
            )}
          </span>
        </div>
      }
    >
      {/* Progress bar */}
      {lastProgress?.total && lastProgress.current != null && (
        <div className="h-1 shrink-0 bg-bg-subtle">
          <div
            className={cn('h-full transition-all', status === 'error' ? 'bg-danger' : 'bg-accent')}
            style={{ width: `${Math.round((lastProgress.current / lastProgress.total) * 100)}%` }}
          />
        </div>
      )}
      {status === 'running' && !lastProgress && (
        <div className="h-1 shrink-0 bg-bg-subtle">
          <div className="h-full w-full animate-pulse bg-accent/40" />
        </div>
      )}

      {/* Log stream */}
      <div className="flex-1 overflow-y-auto p-4">
        {logs.length === 0 && (
          <div className="py-8 text-center text-xs text-fg-subtle">Waiting for events...</div>
        )}
        {logs.map((log, i) => (
          <div key={i} className="flex gap-3 py-1">
            <span className="w-10 shrink-0 text-right font-mono text-xs text-fg-subtle">
              {formatElapsed(logs[0]?.ts, log.ts)}
            </span>
            <div
              className={cn(
                'text-xs',
                log.stage === 'error'
                  ? 'text-danger'
                  : log.stage === 'done'
                    ? 'text-accent'
                    : 'text-fg-muted',
              )}
            >
              <span className="mr-1.5 font-mono text-fg-subtle">[{log.stage}]</span>
              {log.message}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Footer */}
      {status !== 'running' && (
        <div
          className={cn(
            'shrink-0 border-t border-border px-5 py-3 text-xs',
            status === 'done' ? 'text-accent' : 'text-danger',
          )}
        >
          {status === 'done' ? 'Completed — reloading...' : 'Failed — check logs above'}
        </div>
      )}
    </Sheet>
  );
}

function StatusIndicator({ status }: { status: 'running' | 'done' | 'error' }) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          'inline-block h-1.5 w-1.5 rounded-full',
          status === 'running' && 'animate-pulse bg-accent',
          status === 'done' && 'bg-accent',
          status === 'error' && 'bg-danger',
        )}
      />
      <span
        className={cn(
          status === 'running' && 'text-fg-muted',
          status === 'done' && 'text-accent',
          status === 'error' && 'text-danger',
        )}
      >
        {status}
      </span>
    </span>
  );
}

function formatElapsed(startTs: number | undefined, currentTs: number): string {
  if (!startTs) return '0s';
  const sec = Math.round((currentTs - startTs) / 1000);
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m${sec % 60}s`;
}
