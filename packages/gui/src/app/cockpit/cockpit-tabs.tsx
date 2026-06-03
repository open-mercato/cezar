'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/**
 * Phase 5 — "Runs / Runners" tab strip rendered above the cockpit index and
 * the workers page. Hidden on the detail page (`/cockpit/<id>`) so the full-
 * bleed run shell isn't pushed down. usePathname is a thin client-only hook
 * (re-renders cheaply on nav), which keeps the parent layout a pure server
 * component.
 */
export function CockpitTabs() {
  const pathname = usePathname() ?? '/cockpit';
  // Runners tab matches /cockpit/runners and its children, NOT sibling paths
  // like /cockpit/runners-of-doom.
  const isRunners = pathname === '/cockpit/runners' || pathname.startsWith('/cockpit/runners/');
  // Detail pages match /cockpit/<id> but NOT the runners route.
  const isDetail = /^\/cockpit\/[^/]+$/.test(pathname) && !isRunners;
  if (isDetail) return null;
  return (
    <div className="border-b border-border bg-bg">
      <div className="flex items-center gap-1 px-8 pt-4">
        <TabLink href="/cockpit" active={!isRunners}>Runs</TabLink>
        <TabLink href="/cockpit/runners" active={isRunners}>Runners</TabLink>
      </div>
    </div>
  );
}

function TabLink({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'border-b-2 border-accent px-4 py-2 text-sm font-medium text-fg'
          : 'border-b-2 border-transparent px-4 py-2 text-sm text-fg-muted hover:text-fg'
      }
    >
      {children}
    </Link>
  );
}
