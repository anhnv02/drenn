import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import type { PermissionService } from '../permission';
import { sessionManager } from '../agent/subagent';
import type { AgentService } from '../agent';

export class ExitPlanTool implements BaseTool {
  private permissions: PermissionService;
  private agentService: AgentService;

  constructor(permissions: PermissionService, agentService: AgentService) {
    this.permissions = permissions;
    this.agentService = agentService;
  }

  info(): ToolInfo {
    return {
      name: 'exit_plan',
      description: `Use this ONLY in plan mode, once your plan is finished: it presents the plan to the user for approval.

If the user approves, plan mode ends and you should start implementing the plan immediately. If the user rejects it, you stay in plan mode — revise the plan based on their feedback instead of re-submitting the same one.

Do not use this for research tasks or questions; it is only for plans that require making changes.`,
      parameters: {
        type: 'object',
        properties: {
          plan: {
            type: 'string',
            description:
              'The full, final implementation plan in markdown (files to change, changes per file, order, verification steps)',
          },
        },
        required: ['plan'],
      },
      required: ['plan'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    if (ctx.mode !== 'plan') {
      return { content: 'Error: not in plan mode — there is no plan mode to exit.', isError: true };
    }
    if (sessionManager.getSession(ctx.sessionId)) {
      return {
        content:
          'Error: exit_plan is only available in the main session. Return your plan as your final message instead.',
        isError: true,
      };
    }

    let plan: string;
    try {
      plan = String(JSON.parse(call.input).plan ?? '');
    } catch {
      return { content: 'Error: invalid input', isError: true };
    }
    if (!plan.trim()) {
      return { content: 'Error: plan is required', isError: true };
    }

    const decision = await this.permissions.request({
      id: call.id,
      sessionId: ctx.sessionId,
      messageId: ctx.messageId,
      toolName: 'exit_plan',
      action: 'plan_exit',
      description: 'Approve this plan and exit plan mode?',
      params: { plan },
      resource: 'plan',
      cwd: ctx.cwd,
    });

    if (!decision.approved) {
      const feedback = decision.feedback
        ? ` The user provided the following feedback:\n<user_feedback>\n${decision.feedback}\n</user_feedback>`
        : '';
      return {
        content:
          'The user rejected the plan. Stay in plan mode: ask what should change or revise the plan based on their feedback. Do not start implementing.' +
          feedback,
        isError: true,
      };
    }

    this.agentService.setMode(
      ctx.sessionId,
      decision.updatedMode === 'acceptEdits' ? 'acceptEdits' : 'default',
    );
    return {
      content:
        'Plan approved — plan mode is off and editing tools are available from your next turn. Begin implementing the plan now.',
      isError: false,
    };
  }
}
