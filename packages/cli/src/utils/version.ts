import { createRequire } from 'node:module';

let version = '0.0.0';
try {
  const require = createRequire(import.meta.url);
  const pkg = require('../../package.json') as { version?: string };
  if (pkg.version) version = pkg.version;
} catch {
  // Bundled build — package.json is not resolvable here; the version stamped at build time is used instead.
}

export const VERSION = version;
