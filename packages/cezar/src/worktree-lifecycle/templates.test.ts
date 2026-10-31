import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { lifecycleCommandFingerprint, renderLifecycleCommand, validateLifecycleCommand } from './templates.ts';

const context = { root_path: '/tmp/project', worktree_path: '/tmp/task', worktree_id: 'cez-123', task_id: '123' };
describe('lifecycle command rendering', () => {
  it('round-trips adversarial values as a single shell word with static suffixes', () => {
    const path = '/tmp/space \' " $HOME; $(echo INJECTED) `echo bad` 雪 {{task_id}}';
    const command = renderLifecycleCommand('printf "%s\\n" {{ root_path }}/file {{worktree_path}}', { ...context, root_path: path, worktree_path: path });
    expect(execFileSync('bash', ['-c', command], { encoding: 'utf8' })).toBe(`${path}/file\n${path}\n`);
  });
  it.each([
    'echo "{{root_path}}"', "echo '{{root_path}}'", 'echo `echo {{root_path}}`',
    'echo $(echo {{root_path}})', 'cat <<EOF\n{{root_path}}\nEOF',
    'echo $(({{task_id}}))', '(( {{task_id}} ))', '# {{root_path}}',
    'echo ${value:-{{root_path}}}', '[[ {{root_path}} == x ]]',
    'echo $( (echo x); echo {{root_path}} )', 'echo ${{root_path}}', 'a[{{task_id}}]=x',
  ])('rejects unsupported placement: %s', command => {
    expect(() => renderLifecycleCommand(command, context)).toThrow(/position/);
  });
  it('allows ordinary templates after closed nested contexts and comments', () => {
    expect(renderLifecycleCommand('echo "$(echo x)"; # hi\necho {{task_id}}', context)).toContain("echo '123'");
  });
  it('passes token-free Bash through unchanged', () => {
    const command = "for x in a b; do echo \"$(printf '%s' \"$x\")\"; done";
    expect(renderLifecycleCommand(command, context)).toBe(command);
  });
  it('consumes literal-brace escape in quoted Docker formats', () => {
    expect(renderLifecycleCommand("docker inspect --format '\\{{ .Name }}' {{worktree_id}}", context))
      .toBe("docker inspect --format '{{ .Name }}' 'cez-123'");
  });
  it.each(['echo {{unknown}}', 'echo {{root_path', '   '])('validates malformed input: %s', command => {
    expect(() => validateLifecycleCommand(command)).toThrow();
  });
  it('rejects missing and control-character context', () => {
    expect(() => renderLifecycleCommand('echo {{root_path}}', { ...context, root_path: '' })).toThrow(/unavailable/);
    expect(() => renderLifecycleCommand('echo {{root_path}}', { ...context, root_path: '/tmp/\n' })).toThrow(/control/);
  });
  it('fingerprints exact command and resolved context deterministically', () => {
    expect(lifecycleCommandFingerprint('echo {{root_path}}', context)).toBe(lifecycleCommandFingerprint('echo {{root_path}}', { ...context }));
    expect(lifecycleCommandFingerprint('echo {{root_path}}', context)).not.toBe(lifecycleCommandFingerprint('echo  {{root_path}}', context));
  });
});
