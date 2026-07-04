export type { ProjectEnvSpec, RunEnv, ShellResult, DevServerHandle } from './run-env.js';
export { tailLines, waitForHttp } from './run-env.js';
export { NativeShellEnv } from './native-shell-env.js';
export {
  DockerComposeEnv,
  spawnCapture,
  parseHostPort,
  type ComposeCommand,
  type DockerComposeEnvOpts,
} from './docker-compose-env.js';
export { detectComposeFile, firstComposeService, COMPOSE_FILENAMES } from './compose-detect.js';
export { createRunEnv, resolveComposeCommand, type CreateRunEnvOpts } from './create-run-env.js';
