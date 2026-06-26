---
name: dedupe-heuristics
description: Heuristics for identifying duplicate issues against an open-issue knowledge base.
cezar-stages:
  - duplicates
---

# Duplicate-detection heuristics

An issue is a **duplicate** if it describes the same underlying problem or
feature request, even if the wording is completely different. Cosmetic
similarity (same words, different problem) is **not** a duplicate.

## Hard rules

- A candidate can only be a duplicate of a **knowledge-base** issue (the set
  of older / lower-numbered open issues). Candidates are never duplicates of
  other candidates.
- The original is always the **lower-numbered** issue.
- Only flag candidates that **are** duplicates. Omit non-duplicates entirely.
- Minimum confidence to include: **0.80**. If unsure, omit rather than
  guess.
- If a comment thread on the candidate explicitly states this is **not** a
  duplicate, or clarifies it as a distinct issue, omit it.

## What makes two issues "the same"

- Same root cause, even with different reproduction steps.
- Same feature ask, even when phrased differently ("dark mode" /
  "night theme" / "low-light UI").
- Same error fingerprint (matching stack trace top, matching log line) even
  when surrounding context differs.

## What does NOT make them the same

- Same component or area of the codebase — many distinct issues live in one
  area.
- Same severity label or priority label.
- Overlapping keywords without a shared root cause.

## Reason field

One short sentence explaining the match, e.g.:

- `"Both describe the same OAuth redirect mismatch on Safari ≥ 17"`
- `"Both ask for collapsible sidebar groups with persisted state"`
