import type { SVGProps } from 'react';
import { RUN_STATUS_PALETTE } from './run-status-palette';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export function InboxIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 13l2.5-7.5A2 2 0 0 1 7.4 4h9.2a2 2 0 0 1 1.9 1.5L21 13" />
      <path d="M3 13v5a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5" />
      <path d="M3 13h5l1.5 2h5L16 13h5" />
    </svg>
  );
}

export function IssuesIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M9.5 12.5l1.8 1.8 3.5-3.8" />
    </svg>
  );
}

// Approximates GitHub's pull-request icon: two stacked branch circles connected
// by a downward arrow, signalling "merge this branch into another."
export function PullRequestIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="6" cy="18" r="2" />
      <circle cx="18" cy="18" r="2" />
      <path d="M6 8v8" />
      <path d="M18 8v8" />
      <path d="M18 8a4 4 0 0 0-4-4h-2" />
      <path d="M14 2l-2 2 2 2" />
    </svg>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4" />
      <path d="M12 8l1.5 2.5L16 12l-2.5 1.5L12 16l-1.5-2.5L8 12l2.5-1.5L12 8z" />
    </svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M7 9l3 2.5L7 14" />
      <path d="M12 15h5" />
    </svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="8.25" />
      <path d="M12 7.5V12l3 1.8" />
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 13.6a1.8 1.8 0 0 1 0-3.2l1.1-.6-2-3.4-1.2.5a1.8 1.8 0 0 1-2.8-1.6V4h-4v.3a1.8 1.8 0 0 1-2.8 1.6L6.5 5.4l-2 3.4 1.1.6a1.8 1.8 0 0 1 0 3.2l-1.1.6 2 3.4 1.2-.5a1.8 1.8 0 0 1 2.8 1.6V20h4v-.3a1.8 1.8 0 0 1 2.8-1.6l1.2.5 2-3.4-1.1-.6z" />
    </svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="11" cy="11" r="6.25" />
      <path d="M20 20l-3.6-3.6" />
    </svg>
  );
}

export function BellIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 15V11a6 6 0 1 1 12 0v4l1.5 2.25h-15L6 15z" />
      <path d="M10 19.5a2 2 0 0 0 4 0" />
    </svg>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 11a8 8 0 0 1 14.3-4.5L21 9" />
      <path d="M21 4v5h-5" />
      <path d="M20 13a8 8 0 0 1-14.3 4.5L3 15" />
      <path d="M3 20v-5h5" />
    </svg>
  );
}

export function ChevronLeftIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M14.5 6.5L9 12l5.5 5.5" />
    </svg>
  );
}

export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M9.5 6.5L15 12l-5.5 5.5" />
    </svg>
  );
}

export function MoreVerticalIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <circle cx="12" cy="5.5" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M13.5 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8.5L13.5 3z" />
      <path d="M13 3v5.5a1 1 0 0 0 1 1H19" />
    </svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M7 5v14l11-7-11-7z" />
    </svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function RotateLeftIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </svg>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

export function SparkleSmallIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4z" />
    </svg>
  );
}

export function CodeIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M8 7l-5 5 5 5" />
      <path d="M16 7l5 5-5 5" />
    </svg>
  );
}

export function SettingsGearIcon(props: IconProps) {
  return SettingsIcon(props);
}

export function BoltIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M13 3L4 13.5h6l-1 7.5 9-11h-6l1-7z" />
    </svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <svg {...base} {...props}>
      <path d="M4 7h16" />
      <path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12" />
      <path d="M9 7V4h6v3" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

export function StatusDotIcon({
  tone = 'enabled',
  ...props
}: IconProps & {
  tone?:
    | 'enabled'
    | 'disabled'
    | 'warning'
    | 'error'
    | 'running'
    | 'queued'
    | 'paused'
    | 'succeeded';
}) {
  // Run-status tones derive their colour from the single RUN_STATUS_PALETTE
  // source of truth so this icon stays in sync with run-status-dots.tsx.
  // 'warning' aliases the 'paused' colour; 'enabled'/'disabled' are
  // icon-level semantics with no run-status equivalent.
  const color =
    tone === 'enabled'
      ? '#df7412'
      : tone === 'warning'
        ? RUN_STATUS_PALETTE.paused.hex
        : tone === 'error'
          ? RUN_STATUS_PALETTE.failed.hex
          : tone === 'running'
            ? RUN_STATUS_PALETTE.running.hex
            : tone === 'paused'
              ? RUN_STATUS_PALETTE.paused.hex
              : tone === 'succeeded'
                ? RUN_STATUS_PALETTE.succeeded.hex
                : // 'queued' and 'disabled'/fallthrough share the neutral grey
                  RUN_STATUS_PALETTE.queued.hex;
  return (
    <svg {...base} {...props} fill={color} stroke="none">
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}
