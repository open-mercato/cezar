'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from './ui/cn';

interface NavLinkProps {
  href: string;
  label: string;
  icon?: React.ReactNode;
}

export function NavLink({ href, label, icon }: NavLinkProps) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(href + '/');

  return (
    <Link
      href={href}
      className={cn(
        'group relative flex min-h-11 items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors lg:min-h-0',
        active
          ? 'bg-surface-container-high font-medium text-primary'
          : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface',
      )}
    >
      {active && (
        <span className="absolute inset-y-1.5 right-0 w-0.5 rounded-full bg-primary" aria-hidden />
      )}
      {icon && (
        <span
          className={cn(
            'flex h-5 w-5 items-center justify-center',
            active ? 'text-primary' : 'text-on-surface-variant group-hover:text-on-surface',
          )}
        >
          {icon}
        </span>
      )}
      <span className="truncate">{label}</span>
    </Link>
  );
}
