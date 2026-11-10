import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'cezar-chat-webhooks-e2e-'))
const repository = resolve(import.meta.dirname, '../../..')
execFileSync('git', ['init', '-q'], { cwd: root })
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('CEZ_')))
Object.assign(env, {
  CEZ_DRY_RUN: '1', CEZ_HOME: join(root, '.cez-home'), CEZ_WEBHOOKS: '1',
  CEZ_NO_BANNER: '1', CEZ_SKILLS_AUTO_UPDATE: '0', CEZ_AUTOMATIONS: '0', CEZ_TELEMETRY: '0',
})
const child = spawn(process.execPath, ['--import', 'tsx', join(repository, 'packages/cezar/src/index.ts'),
  'serve', '--repo', root, '--port', process.env.PORT, '--no-open'], { cwd: repository, env, stdio: 'inherit' })
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
child.on('exit', code => { rmSync(root, { recursive: true, force: true }); process.exit(code ?? 0) })
