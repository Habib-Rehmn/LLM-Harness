import type { JsonObject, SessionSnapshot } from './protocol.js';

export type ModelHistoryEntry =
  | {
      readonly type: 'message';
      readonly role: 'system' | 'user' | 'assistant';
      readonly content: string;
    }
  | {
      readonly type: 'tool_call';
      readonly role: 'assistant';
      readonly callId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: 'tool_result';
      readonly role: 'tool';
      readonly callId: string;
      readonly content: string;
      readonly isError: boolean;
    };

export function projectModelHistory(snapshot: SessionSnapshot): readonly ModelHistoryEntry[] {
  let history: { readonly sequence: number; readonly entry: ModelHistoryEntry }[] = [];
  for (const item of snapshot.items) {
    if (item.state !== 'completed') continue;
    switch (item.kind) {
      case 'UserMessage':
        history.push({
          sequence: item.sequence,
          entry: { type: 'message', role: 'user', content: item.payload.content },
        });
        break;
      case 'AssistantMessage':
        history.push({
          sequence: item.sequence,
          entry: { type: 'message', role: 'assistant', content: item.payload.content },
        });
        break;
      case 'ToolCall':
        history.push({
          sequence: item.sequence,
          entry: {
            type: 'tool_call',
            role: 'assistant',
            callId: item.payload.callId,
            name: item.payload.name,
            arguments: item.payload.arguments,
          },
        });
        break;
      case 'ToolResult':
        history.push({
          sequence: item.sequence,
          entry: {
            type: 'tool_result',
            role: 'tool',
            callId: item.payload.callId,
            content: item.payload.output,
            isError: item.payload.isError ?? false,
          },
        });
        break;
      case 'ContextCompaction':
        history = [
          {
            sequence: item.sequence,
            entry: {
              type: 'message',
              role: 'system',
              content: `Conversation summary:\n${item.payload.summary}`,
            },
          },
          ...history.filter((entry) => entry.sequence > item.payload.throughSequence),
        ];
        break;
      default:
        break;
    }
  }
  return history.map(({ entry }) => entry);
}
