import type { BrowserWindow } from 'electron';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { IPC } from '../../shared/ipc';
import { runHooks } from '../hooks';

let mainWindow: BrowserWindow | null = null;

export function setQuestionWindow(window: BrowserWindow): void {
  mainWindow = window;
  resendPendingQuestions();
}

function resendPendingQuestions(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  for (const { request } of pendingQuestions.values()) {
    mainWindow.webContents.send(IPC.questionRequest, request);
  }
}

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionRequest {
  id: string;
  sessionId: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
}

let pendingQuestions = new Map<
  string,
  {
    resolve: (answer: string[]) => void;
    request: QuestionRequest;
  }
>();

export function handleQuestionResponse(id: string, answers: string[]): void {
  const pending = pendingQuestions.get(id);
  if (pending) {
    pending.resolve(answers);
    pendingQuestions.delete(id);
  }
}

export function cancelPendingQuestions(sessionId: string): void {
  const ids = [...pendingQuestions.entries()]
    .filter(([, entry]) => entry.request.sessionId === sessionId)
    .map(([id]) => id);
  for (const id of ids) {
    pendingQuestions.get(id)!.resolve([]);
    pendingQuestions.delete(id);
  }
}

export class QuestionTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'question',
      description: `Ask the user questions during execution.
Use this to:
- Gather user preferences or requirements
- Clarify ambiguous instructions
- Get decisions on implementation choices
- Offer choices about what direction to take

Each question includes a header, the question text, and a list of options.`,
      parameters: {
        type: 'object',
        properties: {
          header: {
            type: 'string',
            description: 'Short label for the question (max 30 chars)',
          },
          question: {
            type: 'string',
            description: 'The full question to ask the user',
          },
          options: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
            description: 'List of options for the user to choose from',
          },
          multiple: {
            type: 'boolean',
            description: 'Allow selecting multiple options (default: false)',
          },
        },
        required: ['header', 'question', 'options'],
      },
      required: ['header', 'question', 'options'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = JSON.parse(call.input);
      const { header, question, options, multiple = false } = params;

      if (!header || !question || !options?.length) {
        return { content: 'Error: header, question, and options are required', isError: true };
      }

      const questionId = `q-${Date.now()}`;

      const request: QuestionRequest = {
        id: questionId,
        sessionId: ctx.sessionId,
        header,
        question,
        options,
        multiple,
      };

      void runHooks('Notification', {
        session_id: ctx.sessionId,
        cwd: ctx.cwd,
        message: `Question: ${question}`,
      });

      const answers = await new Promise<string[]>((resolve) => {
        pendingQuestions.set(questionId, { resolve, request });
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.questionRequest, request);
        }
      });

      if (answers.length === 0) {
        return { content: 'The question was cancelled before the user answered.', isError: true };
      }

      return {
        content: `User answered: ${answers.join(', ')}`,
        isError: false,
      };
    } catch (error) {
      return { content: `Error asking question: ${error}`, isError: true };
    }
  }
}
