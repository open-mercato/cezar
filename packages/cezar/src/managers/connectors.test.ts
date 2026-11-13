import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { managerConnectorToolKind, managerConnectorToolMode, type ManagerConnectors } from '@open-mercato/cezar-contract';
import {
  canonicalJson,
  connectorAllowRules,
  connectorCallFence,
  connectorInfos,
  connectorPromptSection,
  observeConnectors,
  parseConnectorTool,
  type ObservedConnectors,
} from './connectors.ts';

const CALENDAR = 'claude_ai_Google_Calendar';
const calendarTools = ['list_events', 'get_event', 'create_event', 'delete_event'];

const observed: ObservedConnectors = {
  observedAt: '2026-11-12T10:00:00.000Z',
  servers: [
    { key: CALENDAR, name: 'claude.ai Google Calendar', status: 'connected', tools: calendarTools },
    { key: 'claude_ai_Gmail', name: 'claude.ai Gmail', status: 'connected', tools: ['search_threads', 'send_message'] },
  ],
};

describe('parseConnectorTool', () => {
  it('splits mcp__<key>__<tool> at the first separator', () => {
    expect(parseConnectorTool('mcp__claude_ai_Google_Calendar__list_events')).toEqual({ key: CALENDAR, tool: 'list_events' });
    expect(parseConnectorTool('mcp__e2e__open_session')).toEqual({ key: 'e2e', tool: 'open_session' });
  });

  it('refuses anything that is not a connector tool', () => {
    expect(parseConnectorTool('Bash')).toBeUndefined();
    expect(parseConnectorTool('mcp__only')).toBeUndefined();
    expect(parseConnectorTool('mcp__a__b c')).toBeUndefined();
  });
});

describe('observeConnectors', () => {
  it('keys servers the way Claude spells them in tool names', () => {
    const state = observeConnectors({
      servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }, { name: 'e2e', status: 'connected' }],
      tools: ['Read', 'mcp__claude_ai_Google_Calendar__list_events', 'mcp__e2e__call', 'mcp__orphan__ping'],
    }, undefined, 'now');
    expect(state).toEqual({
      observedAt: 'now',
      servers: [
        { key: CALENDAR, name: 'claude.ai Google Calendar', status: 'connected', tools: ['list_events'] },
        { key: 'e2e', name: 'e2e', status: 'connected', tools: ['call'] },
        { key: 'orphan', name: 'orphan', status: 'connected', tools: ['ping'] },
      ],
    });
  });

  it('keeps the last known tools of a server that is reconnecting', () => {
    const state = observeConnectors({ servers: [{ name: 'claude.ai Google Calendar', status: 'pending' }], tools: [] }, observed, 'later');
    expect(state.servers).toEqual([{ key: CALENDAR, name: 'claude.ai Google Calendar', status: 'pending', tools: calendarTools }]);
  });
});

describe('connectorAllowRules', () => {
  it('read: exact names of the read tools only, never a wildcard', () => {
    expect(connectorAllowRules({ [CALENDAR]: { level: 'read' } }, observed)).toEqual([
      'mcp__claude_ai_Google_Calendar__get_event',
      'mcp__claude_ai_Google_Calendar__list_events',
    ]);
  });

  it('write: write tools still need a card; an "allow without asking" override adds one', () => {
    const grants: ManagerConnectors = { [CALENDAR]: { level: 'write', tools: { create_event: 'allow', list_events: 'deny' } } };
    expect(connectorAllowRules(grants, observed)).toEqual([
      'mcp__claude_ai_Google_Calendar__create_event',
      'mcp__claude_ai_Google_Calendar__get_event',
    ]);
  });

  it('off, absent and never-observed grants allow nothing', () => {
    expect(connectorAllowRules(undefined, observed)).toEqual([]);
    expect(connectorAllowRules({ [CALENDAR]: { level: 'off', tools: { list_events: 'allow' } } }, observed)).toEqual([]);
    expect(connectorAllowRules({ claude_ai_Drive: { level: 'read' } }, observed)).toEqual([]);
    expect(connectorAllowRules({ [CALENDAR]: { level: 'read' } }, undefined)).toEqual([]);
  });
});

describe('connectorInfos', () => {
  it('judges every observed tool by the current grants', () => {
    const [calendar, gmail] = connectorInfos({ [CALENDAR]: { level: 'write' } }, observed);
    expect(calendar?.tools).toEqual([
      { name: 'list_events', kind: 'read', mode: 'allow' },
      { name: 'get_event', kind: 'read', mode: 'allow' },
      { name: 'create_event', kind: 'write', mode: 'ask' },
      { name: 'delete_event', kind: 'write', mode: 'ask' },
    ]);
    expect(gmail?.tools.every((tool) => tool.mode === 'deny')).toBe(true);
  });
});

describe('connectorPromptSection', () => {
  it('lists what may be called directly, what needs a card, and the unavailable rule', () => {
    const text = connectorPromptSection({ [CALENDAR]: { level: 'write' }, claude_ai_Gmail: { level: 'off' } }, observed);
    expect(text).toContain('claude.ai Google Calendar (connector claude_ai_Google_Calendar): read and write; connected');
    expect(text).toContain('call directly: list_events, get_event');
    expect(text).toContain('only through propose-action, one approval card per call: create_event, delete_event');
    expect(text).toContain('temporarily unavailable');
    expect(text).not.toContain('Gmail');
  });

  it('says how to grant one when none is, and nothing when none was ever seen', () => {
    expect(connectorPromptSection(undefined, observed)).toContain('none granted');
    expect(connectorPromptSection(undefined, undefined)).toBe('');
  });
});

describe('the call fence', () => {
  it('compares canonical JSON, key order aside', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [2, { x: 0, y: 1 }] }, b: 1 }));
  });

  it('its hook passes the approved call only, and fails closed', () => {
    const tool = 'mcp__claude_ai_Google_Calendar__create_event';
    const fence = connectorCallFence(tool, { summary: 'Kick-Off', attendees: ['a@b.c'] });
    try {
      const { command } = (fence.settings as { hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> } }).hooks.PreToolUse[0]!.hooks[0]!;
      const run = (input: string) => spawnSync(command, { shell: true, input, encoding: 'utf8' });
      expect(run(JSON.stringify({ tool_name: tool, tool_input: { attendees: ['a@b.c'], summary: 'Kick-Off' } })).status).toBe(0);
      const again = run(JSON.stringify({ tool_name: tool, tool_input: { summary: 'Kick-Off', attendees: ['a@b.c'] } }));
      expect(again.status).toBe(2);
      expect(again.stderr).toContain('already ran once');
      const changed = run(JSON.stringify({ tool_name: tool, tool_input: { attendees: ['evil@x.y'], summary: 'Kick-Off' } }));
      expect(changed.status).toBe(2);
      expect(changed.stderr).toContain('differs');
      expect(run(JSON.stringify({ tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: {} })).status).toBe(2);
      expect(run('not json').status).toBe(2);
    } finally {
      fence.cleanup();
    }
  });
});

describe('managerConnectorToolKind', () => {
  it('reads only unambiguous read verbs as read', () => {
    for (const tool of ['list_events', 'get_event', 'search_threads', 'download_file_content', 'suggest_time']) {
      expect(managerConnectorToolKind(tool)).toBe('read');
    }
  });

  it('treats verbs that write in real servers as write, so a Read grant never auto-allows them', () => {
    for (const tool of ['resolve_error', 'query', 'check_in', 'fetch', 'send_message', 'frobnicate']) {
      expect(managerConnectorToolKind(tool)).toBe('write');
      expect(managerConnectorToolMode({ level: 'read' }, tool)).toBe('deny');
      expect(managerConnectorToolMode({ level: 'write' }, tool)).toBe('ask');
    }
  });
});
