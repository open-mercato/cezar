---
title: "Fix: composer / menu does not scroll with arrow keys"
ramp: 5
routed-to: om-auto-create-pr
---

## Problem

The `/` skill autocomplete popup in the composer (`packages/web/src/components/composer/composer.tsx`) does not scroll when the user navigates with arrow keys. The highlight moves off-screen but the `CommandList` container stays put.

## Root cause

The custom `onKeyDown` handler (line 346) intercepts ArrowUp/ArrowDown with `event.preventDefault()` and calls `setMenuValue()`. Because cmdk never sees the key event, its internal `scrollIntoView` never fires. The selected item changes visually (via controlled `value` prop) but the scroll position doesn't follow.

## Fix

Add a `useLayoutEffect` keyed on `activeValue` that scrolls the `[data-selected="true"]` item into view:

```tsx
useLayoutEffect(() => {
  const el = rootRef.current?.querySelector<HTMLElement>(
    '[cmdk-item][data-selected="true"]'
  )
  el?.scrollIntoView({ block: 'nearest' })
}, [activeValue])
```

This must be `useLayoutEffect` (not `useEffect` or inline in the handler) because the DOM attribute `data-selected` is only updated after React re-renders with the new `value` prop — `useLayoutEffect` fires after the DOM commit but before paint, guaranteeing the correct element is targeted.

## Scope

- One file: `packages/web/src/components/composer/composer.tsx`
- ~5 lines added
- No new dependencies
- Existing test mocks `scrollIntoView` already (`composer.test.tsx:15`)

## Not in scope

- Command palette (⌘K) — uses cmdk's native keyboard handling, scrolls correctly
- Skills catalog page — different component, no popup
