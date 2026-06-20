import type { IssueStore, Config } from '@cezar/core';

export interface ActionBadge {
  badge: string;
  available: true | string;
}

export function computeBadges(store: IssueStore, config: Config): Record<string, ActionBadge> {
  const open = store.getIssues({ state: 'open' });
  const openDigest = store.getIssues({ state: 'open', hasDigest: true });
  const allDigest = store.getIssues({ hasDigest: true });
  const closedDigest = store.getIssues({ state: 'closed', hasDigest: true });
  const hasDigestIssues = allDigest.length > 0;
  const hasOpenIssues = open.length > 0;
  const hasOpenDigest = openDigest.length > 0;
  const meta = store.getMeta();

  const noDigest = 'no issues with digest — run init first';
  const noOpen = 'no open issues';
  const noOpenDigest = 'no open issues with digest';

  return {
    duplicates: {
      badge: (() => {
        const unanalyzed = allDigest.filter((i) => i.analysis.duplicatesAnalyzedAt === null).length;
        const updated = allDigest.filter(
          (i) =>
            i.analysis.duplicatesAnalyzedAt !== null &&
            i.commentsFetchedAt !== null &&
            i.commentsFetchedAt > i.analysis.duplicatesAnalyzedAt,
        ).length;
        const total = unanalyzed + updated;
        if (total === 0) return 'up to date';
        const parts: string[] = [];
        if (unanalyzed > 0) parts.push(`${unanalyzed} unanalyzed`);
        if (updated > 0) parts.push(`${updated} updated`);
        return parts.join(', ');
      })(),
      available: hasDigestIssues ? true : noDigest,
    },

    'missing-info': {
      badge: (() => {
        const bugs = openDigest.filter((i) => i.digest?.category === 'bug');
        const unchecked = bugs.filter((i) => i.analysis.missingInfoAnalyzedAt === null).length;
        const updated = bugs.filter(
          (i) =>
            i.analysis.missingInfoAnalyzedAt !== null &&
            i.commentsFetchedAt !== null &&
            i.commentsFetchedAt > i.analysis.missingInfoAnalyzedAt,
        ).length;
        const total = unchecked + updated;
        if (total === 0) return 'up to date';
        const parts: string[] = [];
        if (unchecked > 0) parts.push(`${unchecked} unchecked`);
        if (updated > 0) parts.push(`${updated} updated`);
        return parts.join(', ');
      })(),
      available: openDigest.some((i) => i.digest?.category === 'bug')
        ? true
        : 'no bug reports with digest',
    },

    'auto-label': {
      badge: (() => {
        const unl = openDigest.filter((i) => i.analysis.labelsAnalyzedAt === null).length;
        return unl > 0 ? `${unl} unlabeled` : 'up to date';
      })(),
      available: hasDigestIssues ? true : noDigest,
    },

    'recurring-questions': {
      badge: (() => {
        const qs = openDigest.filter((i) => i.digest?.category === 'question');
        const unchecked = qs.filter((i) => i.analysis.recurringAnalyzedAt === null).length;
        return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
      })(),
      available: (() => {
        const hasQs = openDigest.some((i) => i.digest?.category === 'question');
        if (!hasQs) return 'no open questions with digest';
        if (closedDigest.length === 0) return 'no closed issues to compare against';
        return true;
      })(),
    },

    priority: {
      badge: (() => {
        const unscored = openDigest.filter((i) => i.analysis.priorityAnalyzedAt === null).length;
        return unscored > 0 ? `${unscored} unscored` : 'up to date';
      })(),
      available: hasDigestIssues ? true : noDigest,
    },

    'good-first-issue': {
      badge: (() => {
        const unchecked = openDigest.filter(
          (i) =>
            !i.labels.includes('good first issue') && i.analysis.goodFirstIssueAnalyzedAt === null,
        ).length;
        return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
      })(),
      available: hasOpenDigest ? true : noOpenDigest,
    },

    security: {
      badge: (() => {
        const unscanned = openDigest.filter((i) => i.analysis.securityAnalyzedAt === null).length;
        return unscanned > 0 ? `${unscanned} unscanned` : 'up to date';
      })(),
      available: hasDigestIssues ? true : noDigest,
    },

    stale: {
      badge: (() => {
        const threshold = 90;
        const now = Date.now();
        const staleIssues = openDigest.filter(
          (i) => (now - new Date(i.updatedAt).getTime()) / (1000 * 60 * 60 * 24) >= threshold,
        );
        if (staleIssues.length === 0) return 'no stale issues';
        const unanalyzed = staleIssues.filter((i) => i.analysis.staleAnalyzedAt === null).length;
        return unanalyzed > 0
          ? `${unanalyzed} unanalyzed`
          : `${staleIssues.length} stale (all analyzed)`;
      })(),
      available: hasOpenDigest ? true : noOpenDigest,
    },

    'contributor-welcome': {
      badge: (() => {
        const pending = openDigest.filter((i) => i.analysis.welcomeCommentPostedAt === null).length;
        return pending > 0 ? `${pending} pending` : 'up to date';
      })(),
      available: hasOpenDigest ? true : noOpenDigest,
    },

    quality: {
      badge: (() => {
        const unchecked = open.filter((i) => i.analysis.qualityAnalyzedAt === null).length;
        return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
      })(),
      available: hasOpenIssues ? true : noOpen,
    },

    'done-detector': {
      badge: (() => {
        const unchecked = openDigest.filter((i) => i.analysis.doneAnalyzedAt === null).length;
        return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
      })(),
      available: hasOpenDigest ? true : noOpenDigest,
    },

    'claim-detector': {
      badge: (() => {
        const unchecked = open.filter((i) => i.analysis.claimDetectedAt === null).length;
        return unchecked > 0 ? `${unchecked} unchecked` : 'up to date';
      })(),
      available: hasOpenIssues ? true : noOpen,
    },

    categorize: {
      badge: (() => {
        const uncategorized = openDigest.filter(
          (i) => i.analysis.featureCategoryAnalyzedAt === null,
        ).length;
        return uncategorized > 0 ? `${uncategorized} uncategorized` : 'up to date';
      })(),
      available: hasDigestIssues ? true : noDigest,
    },

    'bug-detector': {
      badge: (() => {
        const unclassified = allDigest.filter((i) => i.analysis.bugAnalyzedAt === null).length;
        if (unclassified > 0) return `${unclassified} unclassified`;
        const bugs = allDigest.filter((i) => i.analysis.issueType === 'bug').length;
        return `${bugs} bugs detected`;
      })(),
      available: hasDigestIssues ? true : noDigest,
    },

    autofix: {
      badge: (() => {
        const minConf = config.autofix.minBugConfidence;
        const eligible = allDigest.filter(
          (i) =>
            i.analysis.issueType === 'bug' &&
            (i.analysis.bugConfidence ?? 0) >= minConf &&
            i.analysis.autofixStatus !== 'pr-opened',
        ).length;
        const prs = allDigest.filter((i) => i.analysis.autofixStatus === 'pr-opened').length;
        if (eligible === 0 && prs === 0) return 'nothing to fix';
        const parts: string[] = [];
        if (eligible > 0) parts.push(`${eligible} eligible`);
        if (prs > 0) parts.push(`${prs} PR(s) open`);
        return parts.join(' · ');
      })(),
      available: (() => {
        const hasBugs = allDigest.some((i) => i.analysis.issueType === 'bug');
        return hasBugs ? true : 'no bug-classified issues — run bug-detector first';
      })(),
    },
  };
}
