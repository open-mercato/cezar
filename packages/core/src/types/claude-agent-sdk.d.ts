// Minimal ambient type declarations for @anthropic-ai/claude-agent-sdk.
// These exist so the project typechecks before `npm install` brings in the
// real package. Once the dependency is installed the real bundled types
// take precedence via module resolution; this file can be deleted at that
// point if the upstream types cover our usage.
declare module '@anthropic-ai/claude-agent-sdk' {
  export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

  export interface Usage {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  }

  export interface SDKMessageBase {
    type: string;
  }

  export interface SDKAssistantMessage extends SDKMessageBase {
    type: 'assistant';
    message: {
      content: Array<
        | { type: 'text'; text: string }
        | { type: 'tool_use'; id: string; name: string; input: unknown }
        | { type: 'tool_result'; tool_use_id: string; content: unknown }
      >;
      usage?: Usage;
    };
  }

  export interface SDKResultMessage extends SDKMessageBase {
    type: 'result';
    subtype: string;
    is_error: boolean;
    result?: string;
    usage?: Usage;
    total_cost_usd?: number;
  }

  export interface SDKSystemMessage extends SDKMessageBase {
    type: 'system';
    subtype: string;
  }

  export type SDKMessage =
    | SDKAssistantMessage
    | SDKResultMessage
    | SDKSystemMessage
    | SDKMessageBase;

  export interface QueryOptions {
    cwd?: string;
    systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
    allowedTools?: string[];
    disallowedTools?: string[];
    additionalDirectories?: string[];
    permissionMode?: PermissionMode;
    maxTurns?: number;
    model?: string;
    settingSources?: Array<'user' | 'project' | 'local'>;
    canUseTool?: (
      toolName: string,
      input: unknown,
    ) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;
    hooks?: Record<string, unknown>;
  }

  export interface QueryResult extends AsyncIterable<SDKMessage> {
    interrupt(): Promise<void>;
  }

  export function query(args: {
    prompt: string | AsyncIterable<{ type: 'user'; message: { role: 'user'; content: string } }>;
    options?: QueryOptions;
  }): QueryResult;
}
