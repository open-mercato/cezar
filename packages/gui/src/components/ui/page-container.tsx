import { cn } from './cn';

interface PageContainerProps {
  children: React.ReactNode;
  className?: string;
  /**
   * Optional max-width utility class (e.g. `max-w-[1080px]`). When set the
   * container also centers itself with `mx-auto`. Omit for a full-bleed page.
   */
  max?: string;
}

/**
 * Standard responsive page padding (spec §3.5): phone `px-4 py-4`, tablet
 * `sm:px-6`, desktop `lg:px-8 lg:py-6`. Replaces ad-hoc per-page paddings.
 * Screens adopt this incrementally in later phases.
 */
export function PageContainer({ children, className, max }: PageContainerProps) {
  return (
    <div
      className={cn('px-4 py-4 sm:px-6 lg:px-8 lg:py-6', max && `mx-auto w-full ${max}`, className)}
    >
      {children}
    </div>
  );
}
