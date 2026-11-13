import { RunnerModelCatalog } from './runner-model-catalog.ts';
import { discoverClaudeModels } from './claude-model-catalog.ts';
import { discoverCodexModels } from './codex-model-catalog.ts';
import { discoverOpencodeModels } from './opencode-model-catalog.ts';
import { discoverJunieModels } from './junie-model-catalog.ts';
import { discoverCursorModels } from './cursor-model-catalog.ts';
import { discoverAntigravityModels } from './antigravity-model-catalog.ts';
import { discoverKimiModels } from './kimi-model-catalog.ts';

/** The same authenticated native discovery used by the picker and routing. */
export function createHostModelCatalog(cwd: string): RunnerModelCatalog {
  return new RunnerModelCatalog({ adapters: {
    claude: { discover: () => discoverClaudeModels({ cwd }) },
    codex: { discover: () => discoverCodexModels({ cwd }) },
    opencode: { discover: () => discoverOpencodeModels({ cwd }) },
    junie: { discover: () => discoverJunieModels({ cwd }) },
    cursor: { discover: () => discoverCursorModels() },
    antigravity: { discover: () => discoverAntigravityModels() },
    kimi: { discover: () => discoverKimiModels() },
  } });
}
