import type { TranscriptStep } from '../../shared/types';
import type { ChatMessage } from './types';
import { getTranscript } from '../history';
import { isContinuableSession } from '../session/continuations';

const MAX_IMPORT_CHARS = 48_000;
const MAX_TOOL_SUMMARY_CHARS = 300;

interface ImportedTurn {
  role: 'user' | 'assistant';
  text: string;
}

function describeToolBlock(content: string): string {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && typeof parsed.name === 'string') {
      const input =
        typeof parsed.input === 'string' ? parsed.input : JSON.stringify(parsed.input ?? '');
      return `${parsed.name} ${input}`.slice(0, MAX_TOOL_SUMMARY_CHARS);
    }
  } catch {
    // not JSON — already a summary
  }
  return content.slice(0, MAX_TOOL_SUMMARY_CHARS);
}

function stepToText(step: TranscriptStep): string {
  const parts: string[] = [];
  for (const block of step.blocks) {
    if (block.kind === 'image') {
      parts.push('[pasted image]');
    } else if (block.kind === 'tool') {
      parts.push(`[tool call] ${describeToolBlock(block.content)}`);
    } else if (block.content.trim()) {
      parts.push(block.content);
    }
  }
  return parts.join('\n').trim();
}

export function transcriptStepsToTurns(steps: TranscriptStep[]): ImportedTurn[] {
  const turns: ImportedTurn[] = [];
  for (const step of steps) {
    const text = stepToText(step);
    if (!text) continue;
    const role: ImportedTurn['role'] = step.heading === 'You' ? 'user' : 'assistant';
    const last = turns[turns.length - 1];
    if (last && last.role === role) {
      last.text += `\n\n${text}`;
    } else {
      turns.push({ role, text });
    }
  }
  return turns;
}

export function stripCurrentPrompt(text: string, prompt: string): string | null {
  const withoutImages = text.replace(/(\n\[pasted image\])+$/, '');
  if (withoutImages === prompt) return '';
  if (withoutImages.endsWith('\n\n' + prompt)) return withoutImages.slice(0, -(prompt.length + 2));
  return null;
}

export async function importExternalHistory(
  sessionId: string,
  currentPrompt?: string,
): Promise<ChatMessage[]> {
  if (!isContinuableSession(sessionId)) return [];

  const transcript = await getTranscript(sessionId);
  let turns = transcriptStepsToTurns(transcript.steps);

  const last = turns[turns.length - 1];
  if (currentPrompt && last?.role === 'user') {
    const stripped = stripCurrentPrompt(last.text, currentPrompt.trim());
    if (stripped === '') turns.pop();
    else if (stripped !== null) last.text = stripped;
  }
  if (turns.length === 0) return [];

  let total = 0;
  let start = turns.length;
  while (start > 0 && total + turns[start - 1].text.length <= MAX_IMPORT_CHARS) {
    total += turns[start - 1].text.length;
    start--;
  }
  if (start === turns.length) start = turns.length - 1;
  const truncated = start > 0;
  turns = turns.slice(start);

  const note = truncated
    ? '(Continuing an earlier conversation imported from its session log; older turns were omitted.)'
    : '(Continuing an earlier conversation imported from its session log.)';

  if (turns[0].role === 'user') {
    turns[0] = { role: 'user', text: `${note}\n\n${turns[0].text}` };
  } else {
    turns.unshift({ role: 'user', text: note });
  }

  return turns.map((t) => ({ role: t.role, content: t.text }));
}
