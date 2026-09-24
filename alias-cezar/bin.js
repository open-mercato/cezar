#!/usr/bin/env node
// `npx cezar` resolves this unscoped alias; the real tool is @open-mercato/cezar.
// Bare specifier, never a deep path: that package declares an `exports` map, so Node serves
// only the subpaths it lists and hard-blocks the rest — importing `./dist/index.js` threw
// ERR_PACKAGE_PATH_NOT_EXPORTED at every user, on a file sitting right there in the tarball
// (#851). `.` already maps to ./dist/index.js, so this lands on the same module legally.
import('@open-mercato/cezar');
