import { Suspense } from 'react';
import { WorkspaceWizard } from './wizard';

export default function NewWorkspacePage() {
  return (
    <Suspense fallback={null}>
      <WorkspaceWizard />
    </Suspense>
  );
}
