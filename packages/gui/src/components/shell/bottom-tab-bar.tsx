'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { InboxIcon, IssuesIcon, PullRequestIcon, TerminalIcon, MoreIcon } from '../icons';
import { cn } from '../ui/cn';

interface BottomTabBarProps {
  /** Opens the same MobileNavDrawer used by the hamburger (the "More" tab). */
  onOpenNav: () => void;
}

const TABS = [
  { href: '/inbox', label: 'Inbox', Icon: InboxIcon },
  { href: '/issues', label: 'Issues', Icon: IssuesIcon },
  { href: '/prs', label: 'PRs', Icon: PullRequestIcon },
  { href: '/cockpit', label: 'Runs', Icon: TerminalIcon },
] as const;

/**
 * Phone primary navigation (spec §3.3 / §10.2): fixed bottom bar, `sm:hidden`,
 * `z-nav`, safe-area padded. 5 tabs — Inbox, Issues, PRs, Runs, More. "More"
 * opens the shared MobileNavDrawer (owns Skills/Actions/Workflows/Activity/
 * Settings + workspace switcher + sign out).
 */
export function BottomTabBar({ onOpenNav }: BottomTabBarProps) {
  const pathname = usePathname();

  const isActive = (href: string) => pathname === href || pathname.startsWith(href + '/');
  // "More" owns every destination not covered by the four direct tabs.
  const moreActive = !TABS.some((t) => isActive(t.href));

  const itemClass = (active: boolean) =>
    cn(
      'flex min-h-11 flex-1 flex-col items-center justify-center gap-0.5 py-1.5 text-[11px]',
      active ? 'text-primary' : 'text-on-surface-variant',
    );

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-nav flex border-t border-outline-variant bg-surface-container-low pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      {TABS.map(({ href, label, Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={href}
            href={href}
            className={itemClass(active)}
            aria-current={active ? 'page' : undefined}
          >
            <Icon className="h-5 w-5" />
            <span>{label}</span>
          </Link>
        );
      })}
      <button type="button" onClick={onOpenNav} className={itemClass(moreActive)} aria-label="More">
        <MoreIcon className="h-5 w-5" />
        <span>More</span>
      </button>
    </nav>
  );
}
