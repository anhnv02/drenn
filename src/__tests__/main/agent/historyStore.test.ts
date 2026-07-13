import { describe, it, expect } from 'vitest';
import {
  saveMessageHistory,
  loadMessageHistory,
  deleteMessageHistory,
} from '../../../main/agent/historyStore';
import type { ChatMessage } from '../../../main/agent/types';

const MESSAGES: ChatMessage[] = [
  { role: 'system', content: 'You are a coding assistant.' },
  { role: 'user', content: 'hello' },
  { role: 'assistant', content: 'hi there' },
];

describe('historyStore', () => {
  it('round-trips a session history', async () => {
    const sessionId = `local:test-${Date.now()}`;
    await saveMessageHistory(sessionId, MESSAGES);
    const loaded = await loadMessageHistory(sessionId);
    expect(loaded).toEqual(MESSAGES);
    await deleteMessageHistory(sessionId);
    expect(await loadMessageHistory(sessionId)).toBeNull();
  });

  it('returns null for unknown sessions', async () => {
    expect(await loadMessageHistory('local:does-not-exist')).toBeNull();
  });

  it('does not persist sub-agent sessions', async () => {
    const sessionId = `local:parent-${Date.now()}:sub:explore:123`;
    await saveMessageHistory(sessionId, MESSAGES);
    expect(await loadMessageHistory(sessionId)).toBeNull();
  });

  it('preserves multimodal content parts', async () => {
    const sessionId = `local:mm-${Date.now()}`;
    const multimodal: ChatMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ];
    await saveMessageHistory(sessionId, multimodal);
    expect(await loadMessageHistory(sessionId)).toEqual(multimodal);
    await deleteMessageHistory(sessionId);
  });
});
