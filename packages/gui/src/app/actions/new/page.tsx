import Link from 'next/link';
import { getActiveWorkspace } from '@/lib/workspace';
import { NewActionForm } from './new-action-form';

export default async function NewActionPage() {
  const workspace = await getActiveWorkspace();
  if (!workspace) {
    return (
      <div className="px-6 py-6">
        <div className="rounded-md border border-dashed border-outline-variant bg-surface-container-low p-8 text-center text-sm text-on-surface-variant">
          No workspace selected.{' '}
          <Link href="/workspaces/new" className="text-primary hover:underline">
            Create one first
          </Link>
          .
        </div>
      </div>
    );
  }

  const readOnly = workspace.role !== 'admin';

  return (
    <div className="px-6 py-6">
      <header className="mb-6">
        <nav className="flex items-center gap-2 text-sm text-on-surface-variant">
          <Link href="/actions" className="hover:text-on-surface">
            Actions
          </Link>
          <span aria-hidden>›</span>
          <span className="font-medium text-on-surface">New</span>
        </nav>
        <h1 className="mt-2 text-[24px] font-semibold leading-tight tracking-tight text-on-surface">
          New action
        </h1>
        <p className="mt-1 text-sm text-on-surface-variant">
          Creates an empty <code className="font-mono text-on-surface">user</code> action. You can
          fill in the system prompt, skills, and effects on the detail page.
        </p>
      </header>

      <NewActionForm readOnly={readOnly} />
    </div>
  );
}
