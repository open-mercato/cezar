#!/usr/bin/env node
// `CEZ_BIN` for a source checkout: plain `node` cannot run src/index.ts (see runnableCezBin in src/paths.ts).
import { register } from 'tsx/esm/api';

register();
await import('../src/index.ts');
