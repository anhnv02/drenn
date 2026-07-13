import { describe, it, expect } from 'vitest';
import {
  shouldCompact,
  estimateTokensWithTools,
  buildCompactSessionMessages,
  compactConversation,
} from '../../../main/compact/index';
import type { LLMProvider } from '../../../main/llm/openaiClient';
import type { ChatMessage } from '../../../main/agent/types';

function makeMessages(count: number, contentLength: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  for (let i = 0; i < count; i++) {
    msgs.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: 'x'.repeat(contentLength),
    });
  }
  return msgs;
}

describe('shouldCompact', () => {
  it('returns false when under threshold', async () => {
    const messages = makeMessages(5, 100);
    const result = await shouldCompact(messages, 1_000_000);
    expect(result).toBe(false);
  });

  it('returns true when over threshold', async () => {
    const messages = makeMessages(10, 50000);
    const result = await shouldCompact(messages, 100000);
    expect(result).toBe(true);
  });
});

describe('estimateTokensWithTools', () => {
  it('estimates message tokens', () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'a'.repeat(100) }];
    const tokens = estimateTokensWithTools(messages, []);
    expect(tokens).toBe(25);
  });

  it('adds tool definition tokens', () => {
    const messages: ChatMessage[] = [];
    const tools = [
      {
        description: 'A tool description',
        parameters: { type: 'object', properties: { x: { type: 'string' } } },
      },
    ];
    const tokens = estimateTokensWithTools(messages, tools);
    expect(tokens).toBeGreaterThan(0);
  });

  it('handles tools without description', () => {
    const messages: ChatMessage[] = [];
    const tools = [{ parameters: { type: 'object' } }];
    const tokens = estimateTokensWithTools(messages, tools);
    expect(tokens).toBeGreaterThan(0);
  });

  it('counts multimodal image parts', () => {
    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(4000)}` } },
        ],
      },
    ];
    const tokens = estimateTokensWithTools(messages, []);
    expect(tokens).toBeGreaterThan(1000);
  });

  it('counts assistant tool_calls arguments', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'write', arguments: 'x'.repeat(4000) } },
        ],
      },
    ];
    const tokens = estimateTokensWithTools(messages, []);
    expect(tokens).toBeGreaterThan(1000);
  });
});

describe('compactConversation', () => {
  const fakeProvider = {
    streamChat: async function* () {
      yield { type: 'content', content: 'the summary' };
      yield { type: 'complete', usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as LLMProvider;

  it('never starts recent on an orphaned tool message', async () => {
    const messages: ChatMessage[] = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 9; i++) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` });
    }
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'view', arguments: '{}' } },
        { id: 'c2', type: 'function', function: { name: 'view', arguments: '{}' } },
      ],
    });
    messages.push({ role: 'tool', content: 'r1', tool_call_id: 'c1' });
    messages.push({ role: 'tool', content: 'r2', tool_call_id: 'c2' });
    for (let i = 0; i < 8; i++) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: `t${i}` });
    }

    const result = await compactConversation(messages, fakeProvider);
    expect(result.summary).toBe('the summary');
    expect(result.recent.length).toBeGreaterThan(0);
    expect(result.recent[0].role).not.toBe('tool');
  });
});

describe('buildCompactSessionMessages', () => {
  it('builds messages with summary', () => {
    const messages = buildCompactSessionMessages('Test summary', '/project');
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toContain('Test summary');
    expect(messages[0].content).toContain('/project');
  });

  it('includes recent messages', () => {
    const recent: ChatMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const messages = buildCompactSessionMessages('Summary', '/project', recent);
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toBe('Hello');
    expect(messages[2].content).toBe('Hi there');
  });

  it('handles empty recent messages', () => {
    const messages = buildCompactSessionMessages('Summary', '/project', []);
    expect(messages).toHaveLength(1);
  });

  it('includes platform info', () => {
    const messages = buildCompactSessionMessages('Summary', '/project');
    expect(messages[0].content).toContain('Platform:');
  });
});
