import type { HarnessSkillProfile } from './types.js';

export interface HarnessPhaseSkills {
  specWriting: string;
  preImplement: string;
  implementSpec: string;
  codeReview: string;
  qualify: string;
  diagnose: string;
  fix: string;
}

const GENERIC_PHASE_SKILLS: HarnessPhaseSkills = {
  specWriting: 'cez-spec-writing',
  preImplement: 'cez-pre-implement-spec',
  implementSpec: 'cez-implement-spec',
  codeReview: 'cez-code-review',
  qualify: 'cez-verify-in-repo',
  diagnose: 'cez-root-cause',
  fix: 'cez-fix',
};

const OPEN_MERCATO_PHASE_SKILLS: HarnessPhaseSkills = {
  specWriting: 'om-spec-writing',
  preImplement: 'om-pre-implement-spec',
  implementSpec: 'om-implement-spec',
  codeReview: 'om-code-review',
  qualify: 'om-verify-in-repo',
  diagnose: 'om-root-cause',
  fix: 'om-fix',
};

/**
 * The graph is fixed; only its complete judgment playbooks vary. Open Mercato
 * uses the exact canonical om-* names so repository-local extensions compose
 * normally. Other repositories use Cezar's full generic playbooks.
 */
export function harnessPhaseSkills(
  profile: HarnessSkillProfile = 'generic',
): HarnessPhaseSkills {
  return {
    ...(profile === 'open-mercato' ? OPEN_MERCATO_PHASE_SKILLS : GENERIC_PHASE_SKILLS),
  };
}
