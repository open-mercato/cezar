import * as React from 'react'

/* Radix→Base UI compat: Radix composes via `asChild`, Base UI via `render`. The ui/ wrappers
 * keep accepting `asChild` so the ~20 existing call sites don't change while primitives migrate
 * one batch at a time. Spread the result AFTER {...props} so `children` never double-lands. */
export function asChildProps(
  asChild: boolean | undefined,
  children: React.ReactNode,
): { render: React.ReactElement<Record<string, unknown>> } | { children: React.ReactNode } {
  if (asChild && React.isValidElement(children)) {
    return { render: children as React.ReactElement<Record<string, unknown>> }
  }
  return { children }
}

export function applyRef<T>(ref: React.Ref<T> | undefined, node: T | null) {
  if (typeof ref === 'function') ref(node)
  else if (ref && typeof ref === 'object') (ref as React.MutableRefObject<T | null>).current = node
}
