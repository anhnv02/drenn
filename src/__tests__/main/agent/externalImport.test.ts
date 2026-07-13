import { describe, expect, it } from 'vitest';
import {
  transcriptStepsToTurns,
  importExternalHistory,
  stripCurrentPrompt,
} from '../../../main/agent/externalImport';
import type { TranscriptStep } from '../../../shared/types';

function step(heading: string, blocks: TranscriptStep['blocks'], id = 's'): TranscriptStep {
  return { id, heading, finished: true, blocks };
}

describe('transcriptStepsToTurns', () => {
  it('maps You to user and everything else to assistant', () => {
    const turns = transcriptStepsToTurns([
      step('You', [{ kind: 'text', content: 'hello' }]),
      step('Claude', [{ kind: 'text', content: 'hi there' }]),
      step('You', [{ kind: 'text', content: 'continue' }]),
      step('Copilot', [{ kind: 'text', content: 'ok' }]),
    ]);
    expect(turns).toEqual([
      { role: 'user', text: 'hello' },
      { role: 'assistant', text: 'hi there' },
      { role: 'user', text: 'continue' },
      { role: 'assistant', text: 'ok' },
    ]);
  });

  it('merges consecutive same-role steps into one turn', () => {
    const turns = transcriptStepsToTurns([
      step('Assistant', [{ kind: 'text', content: 'part one' }]),
      step('ToolCall', [{ kind: 'tool', content: 'bash: npm test' }]),
      step('Assistant', [{ kind: 'text', content: 'part two' }]),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].role).toBe('assistant');
    expect(turns[0].text).toContain('part one');
    expect(turns[0].text).toContain('[tool call] bash: npm test');
    expect(turns[0].text).toContain('part two');
  });

  it('renders local-format JSON tool blocks as name + input', () => {
    const content = JSON.stringify({
      id: 'x',
      name: 'edit',
      input: '{"file_path":"/tmp/a.ts"}',
      result: { content: 'ok' },
    });
    const turns = transcriptStepsToTurns([step('ToolCall', [{ kind: 'tool', content }])]);
    expect(turns[0].text).toContain('edit {"file_path":"/tmp/a.ts"}');
  });

  it('replaces images with a placeholder and skips empty steps', () => {
    const turns = transcriptStepsToTurns([
      step('You', [{ kind: 'text', content: '   ' }]),
      step('You', [
        { kind: 'image', content: 'data:image/png;base64,xxxx' },
        { kind: 'text', content: 'see screenshot' },
      ]),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain('[pasted image]');
    expect(turns[0].text).not.toContain('base64');
  });
});

describe('stripCurrentPrompt', () => {
  it('removes a turn that is exactly the prompt', () => {
    expect(stripCurrentPrompt('fix the bug', 'fix the bug')).toBe('');
  });

  it('ignores trailing image placeholders from the persisted step', () => {
    expect(stripCurrentPrompt('fix the bug\n[pasted image]', 'fix the bug')).toBe('');
  });

  it('strips only the tail of a merged user turn', () => {
    expect(stripCurrentPrompt('earlier question\n\nfix the bug', 'fix the bug')).toBe(
      'earlier question',
    );
  });

  it('leaves unrelated text alone', () => {
    expect(stripCurrentPrompt('something else', 'fix the bug')).toBeNull();
  });
});

describe('importExternalHistory', () => {
  it('returns empty for non-continuable session ids', async () => {
    expect(await importExternalHistory('local:123')).toEqual([]);
    expect(await importExternalHistory('whatever')).toEqual([]);
  });
});
