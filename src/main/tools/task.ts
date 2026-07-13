import type { BaseTool, ToolInfo, ExecutionContext, ToolCall, ToolResponse } from './types';
import {
  listSubAgents,
  listProjectAgents,
  getAgent,
  backgroundJobService,
  sessionManager,
  modeToPermissionRuleset,
} from '../agent/subagent';
import type { AgentSession } from '../agent/subagent';
import { AgentService } from '../agent';

const TASK_DESCRIPTION = `Launch a new agent to handle complex, multistep tasks autonomously.

When using the Task tool, you must specify a subagent_type parameter to select which agent type to use.

Available agent types and the tools they have access to:
{agents}

When NOT to use the Task tool:
- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool
- If you are searching for a specific class definition like "class Foo", use the Grep tool instead
- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead

Usage notes:
1. Launch multiple agents concurrently whenever possible, to maximize performance
2. Once you have delegated work to an agent, do not duplicate that work yourself
3. When the agent is done, it will return a single message back to you. The result is not visible to the user — summarize what matters in your own response
4. Each invocation is stateless: your prompt must contain a highly detailed task description, all the context the agent needs, and exactly what information it should return
5. The agent's outputs should generally be trusted
6. Clearly tell the agent whether you expect it to write code or just to do research, since it is not aware of the user's intent`;

const BACKGROUND_DESCRIPTION = [
  'Background mode: background=true launches the subagent asynchronously and returns immediately.',
  'Foreground is the default; use it when you need the result before continuing.',
  'Use background only for independent work that can run while you continue elsewhere.',
  'You will be notified automatically when it finishes.',
].join(' ');

const BACKGROUND_STARTED = [
  'The task is working in the background. You will be notified automatically when it finishes.',
  "DO NOT sleep, poll for progress, ask the task for status, or duplicate this task's work.",
  'Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.',
].join('\n');

export class TaskTool implements BaseTool {
  private agentService: AgentService;
  private static seq = 0;

  constructor(agentService: AgentService) {
    this.agentService = agentService;
  }

  info(): ToolInfo {
    const agents = listSubAgents();
    const description = TASK_DESCRIPTION.replace(
      '{agents}',
      agents.map((a) => `- ${a.config.name}: ${a.config.description}`).join('\n'),
    );

    return {
      name: 'task',
      description,
      parameters: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description: 'A short (3-5 words) description of the task',
          },
          prompt: {
            type: 'string',
            description: 'The task for the agent to perform',
          },
          subagent_type: {
            type: 'string',
            description: 'The type of specialized agent to use for this task',
          },
          task_id: {
            type: 'string',
            description: 'This should only be set if you mean to resume a previous task',
          },
          background: {
            type: 'boolean',
            description: 'Run the agent in the background. You will be notified when it completes.',
          },
        },
        required: ['description', 'prompt', 'subagent_type'],
      },
      required: ['description', 'prompt', 'subagent_type'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const params = JSON.parse(call.input) as {
      description: string;
      prompt: string;
      subagent_type: string;
      task_id?: string;
      background?: boolean;
    };

    const agent = getAgent(params.subagent_type, ctx.cwd);
    if (!agent) {
      const availableTypes = [...listSubAgents(), ...listProjectAgents(ctx.cwd)]
        .map((a) => a.config.name)
        .join(', ');
      return {
        content: `Agent type "${params.subagent_type}" not found. Available types: ${availableTypes}`,
        isError: true,
      };
    }

    if (agent.config.mode === 'primary') {
      return {
        content: `Cannot invoke primary agent "${params.subagent_type}" as a sub-agent. Use a subagent type instead.`,
        isError: true,
      };
    }

    try {
      const parentSession: AgentSession = sessionManager.getSession(ctx.sessionId) ?? {
        id: ctx.sessionId,
        agentName: 'root',
        title: 'root',
        permission: modeToPermissionRuleset(this.agentService.getMode(ctx.sessionId)),
        createdAt: Date.now(),
        status: 'active',
      };

      const childSessionId =
        params.task_id ||
        `${ctx.sessionId}:sub:${params.subagent_type}:${Date.now()}-${TaskTool.seq++}`;

      if (this.agentService.isBusy(childSessionId)) {
        return {
          content: `Task "${params.task_id}" is still running. Do not resume it — you will be notified automatically when it finishes. Work on something else or end your response.`,
          isError: true,
        };
      }

      sessionManager.createSession(
        childSessionId,
        params.subagent_type,
        params.description,
        parentSession,
        agent.config,
      );

      this.agentService.setMode(
        childSessionId,
        params.subagent_type === 'plan' ? 'plan' : this.agentService.getMode(ctx.sessionId),
      );

      backgroundJobService.start(childSessionId, childSessionId, params.background === true);

      const consume = async (): Promise<{
        output: string;
        toolCalls: Array<{ id: string; tool: string; input: any; output?: string }>;
        error?: string;
      }> => {
        let output = '';
        const toolCalls: Array<{ id: string; tool: string; input: any; output?: string }> = [];

        for await (const event of this.agentService.run(
          childSessionId,
          params.prompt,
          ctx.cwd,
          params.subagent_type,
        )) {
          if (event.type === 'content' && event.content) {
            output += event.content;
          } else if (event.type === 'tool_use' && event.toolCall) {
            const existing = toolCalls.find((tc) => tc.id === event.toolCall!.id);
            if (existing) {
              existing.input = event.toolCall.input;
            } else {
              toolCalls.push({
                id: event.toolCall.id,
                tool: event.toolCall.name,
                input: event.toolCall.input,
              });
            }
          } else if (event.type === 'tool_result' && event.toolResult) {
            const matching = toolCalls.find((tc) => tc.id === event.toolCall?.id);
            if (matching) {
              matching.output = event.toolResult.content;
            }
          } else if (event.type === 'error') {
            const message = event.error?.message || 'Unknown error';
            backgroundJobService.error(childSessionId, message);
            sessionManager.updateSessionStatus(childSessionId, 'error');
            return { output, toolCalls, error: message };
          }
        }

        backgroundJobService.complete(childSessionId, output);
        sessionManager.updateSessionStatus(childSessionId, 'completed');
        return { output, toolCalls };
      };

      if (params.background) {
        void consume().catch((err) => {
          backgroundJobService.error(
            childSessionId,
            err instanceof Error ? err.message : String(err),
          );
          sessionManager.updateSessionStatus(childSessionId, 'error');
        });
        return {
          content: BACKGROUND_STARTED,
          isError: false,
          metadata: {
            subagent: params.subagent_type,
            background: true,
            jobId: childSessionId,
          },
        };
      }

      const res = await consume();
      if (res.error) {
        return {
          content: `Sub-agent error: ${res.error}`,
          isError: true,
          metadata: {
            subagent: params.subagent_type,
            toolCalls: res.toolCalls,
          },
        };
      }

      return {
        content: res.output || 'Sub-agent completed with no output',
        isError: false,
        metadata: {
          subagent: params.subagent_type,
          toolCalls: res.toolCalls,
        },
      };
    } catch (error) {
      return {
        content: `Failed to run sub-agent: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }
}
