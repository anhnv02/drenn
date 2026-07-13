import type { LLMProvider } from '../llm/openaiClient';
import type { ChatMessage } from './types';
import { getAgent } from './subagent';

const TITLE_SYSTEM_PROMPT = `Generate a concise, descriptive title (max 50 chars) for this conversation based on the user's first message. Only output the title, no quotes or formatting.`;
const TITLE_TIMEOUT_MS = 15_000;

export async function generateTitle(userMessage: string, provider: LLMProvider): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: TITLE_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  let title = '';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);

  try {
    for await (const event of provider.streamChat(messages, [], controller.signal, {
      temperature: getAgent('title')?.config.temperature,
    })) {
      if (event.type === 'content' && event.content) {
        title += event.content;
      }
    }
  } catch {
    // Timeout or LLM error — fall through to default title
  } finally {
    clearTimeout(timeout);
  }

  // Clean up the title
  title = title.trim();

  // Remove quotes if present
  if (
    (title.startsWith('"') && title.endsWith('"')) ||
    (title.startsWith("'") && title.endsWith("'"))
  ) {
    title = title.slice(1, -1);
  }

  // Truncate if too long
  if (title.length > 50) {
    title = title.slice(0, 47) + '...';
  }

  return title || 'New Session';
}
