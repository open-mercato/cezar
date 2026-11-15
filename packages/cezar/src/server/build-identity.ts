import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Response header carrying the cockpit build this server booted with. The cockpit compares it to
 *  the build it was loaded from, so a server left running across an in-place update (or a tab
 *  left open across a restart) is named instead of failing on strict schemas. */
export const BUILD_HEADER = 'x-cezar-build';

/** The `<meta name="cezar-build">` the web build stamps into index.html (packages/web/vite.config.ts). */
const BUILD_META = /<meta\s+name="cezar-build"\s+content="([^"]{1,200})"/;

/** The build id in a cockpit index.html, or null (dev, a build that predates the stamp). */
export function buildIdFromHtml(html: string): string | null {
  return BUILD_META.exec(html)?.[1] ?? null;
}

/** Read once at boot: the build this process's routes and schemas shipped with. Never throws. */
export function readWebBuildId(distDir: string): string | null {
  try {
    return buildIdFromHtml(readFileSync(join(distDir, 'index.html'), 'utf8'));
  } catch {
    return null;
  }
}
