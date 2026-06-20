// Static catalog of the 19 CEZAR actions, straight from CEZAR-GUI-SPEC.md §2.1.
// Phase 1 will replace this with live badges + availability sourced from
// `@cezar/core/actionRegistry` on the server.

export type ActionGroup = 'triage' | 'intelligence' | 'community';

export interface ActionTile {
  id: string;
  label: string;
  icon: string;
  group: ActionGroup;
  description: string;
  /** Marks actions that are special: autofix requires bug-detector first. */
  flag?: 'headline' | 'prerequisite';
}

export const ACTION_TILES: ActionTile[] = [
  // Triage
  {
    id: 'duplicates',
    label: 'Detect Duplicates',
    icon: '🔍',
    group: 'triage',
    description: 'LLM-powered semantic matching across open/closed issues',
  },
  {
    id: 'missing-info',
    label: 'Missing Info',
    icon: '📝',
    group: 'triage',
    description: 'Flag issues lacking reproduction steps or context',
  },
  {
    id: 'quality',
    label: 'Quality Check',
    icon: '✅',
    group: 'triage',
    description: 'Assess issue quality and completeness',
  },
  {
    id: 'stale',
    label: 'Stale Detection',
    icon: '🕸️',
    group: 'triage',
    description: 'Identify issues with no activity past threshold',
  },
  {
    id: 'done-detector',
    label: 'Done Detector',
    icon: '✔️',
    group: 'triage',
    description: 'Detect issues that are resolved but not closed',
  },
  {
    id: 'claim-detector',
    label: 'Claim Detector',
    icon: '🙋',
    group: 'triage',
    description: 'Detect issues already claimed by contributors',
  },
  // Intelligence
  {
    id: 'priority',
    label: 'Priority Assignment',
    icon: '🎯',
    group: 'intelligence',
    description: 'Auto-classify urgency (P0–P3)',
  },
  {
    id: 'auto-label',
    label: 'Auto-Label',
    icon: '🏷️',
    group: 'intelligence',
    description: 'Apply labels based on rules + LLM classification',
  },
  {
    id: 'categorize',
    label: 'Categorize',
    icon: '📂',
    group: 'intelligence',
    description: 'Classify issues by type and affected area',
  },
  {
    id: 'recurring-questions',
    label: 'Recurring Questions',
    icon: '🔄',
    group: 'intelligence',
    description: 'Detect frequently asked questions across issues',
  },
  {
    id: 'good-first-issue',
    label: 'Good First Issue',
    icon: '🌱',
    group: 'intelligence',
    description: 'Identify issues suitable for new contributors',
  },
  {
    id: 'security',
    label: 'Security Triage',
    icon: '🔒',
    group: 'intelligence',
    description: 'Flag potential security vulnerabilities',
  },
  {
    id: 'bug-detector',
    label: 'Bug Detector',
    icon: '🐛',
    group: 'intelligence',
    description: 'Classify bug/feature/question/other — prerequisite for autofix',
    flag: 'prerequisite',
  },
  {
    id: 'autofix',
    label: 'Autofix',
    icon: '🔧',
    group: 'intelligence',
    description: 'Multi-agent coding pipeline: analyze → fix → review → PR',
    flag: 'headline',
  },
  // Community
  {
    id: 'contributor-welcome',
    label: 'Contributor Welcome',
    icon: '👋',
    group: 'community',
    description: 'Welcome new contributors',
  },
];

export const ACTION_GROUP_LABELS: Record<ActionGroup, string> = {
  triage: 'Triage',
  intelligence: 'Intelligence',
  community: 'Community',
};
