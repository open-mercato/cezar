import { NavLink } from '../nav-link';
import {
  InboxIcon,
  IssuesIcon,
  PullRequestIcon,
  SparkleIcon,
  BoltIcon,
  TerminalIcon,
  ClockIcon,
  SettingsIcon,
  PlayIcon,
} from '../icons';

/**
 * Single source of truth for the primary navigation. Consumed by both the
 * desktop `Sidebar` and the `MobileNavDrawer` so the nav list never drifts.
 */
export const NAV = [
  { href: '/inbox', label: 'Inbox', icon: <InboxIcon className="h-5 w-5" /> },
  { href: '/issues', label: 'Issues', icon: <IssuesIcon className="h-5 w-5" /> },
  { href: '/prs', label: 'PRs', icon: <PullRequestIcon className="h-5 w-5" /> },
  { href: '/skills', label: 'Skills', icon: <SparkleIcon className="h-5 w-5" /> },
  { href: '/actions', label: 'Actions', icon: <BoltIcon className="h-5 w-5" /> },
  { href: '/cockpit', label: 'Runs', icon: <TerminalIcon className="h-5 w-5" /> },
  { href: '/workflows', label: 'Workflows', icon: <PlayIcon className="h-5 w-5" /> },
  { href: '/activity', label: 'Activity', icon: <ClockIcon className="h-5 w-5" /> },
  { href: '/settings', label: 'Settings', icon: <SettingsIcon className="h-5 w-5" /> },
] as const;

/** Renders the list of `NavLink`s from {@link NAV}. */
export function NavItems() {
  return (
    <>
      {NAV.map((item) => (
        <NavLink key={item.href} href={item.href} label={item.label} icon={item.icon} />
      ))}
    </>
  );
}
