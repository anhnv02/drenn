export type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
export { ViewTool } from './view';
export { GlobTool } from './glob';
export { GrepTool } from './grep';
export { LsTool } from './ls';
export { EditTool } from './edit';
export { WriteTool } from './write';
export { BashTool } from './bash';
export { FetchTool } from './fetch';
export { ApplyPatchTool } from './applyPatch';
export { TodoWriteTool, type TodoItem, getTodos, clearTodos } from './todowrite';
export { MemoryTool } from './memory';
export { QuestionTool, handleQuestionResponse } from './question';
export { DiagnosticsTool } from './diagnostics';
export { SourcegraphTool } from './sourcegraph';
export { TaskTool } from './task';
export { ExitPlanTool } from './exitPlan';
export { BashOutputTool, KillShellTool } from './backgroundShells';
export { WebSearchTool } from './websearch';

import type { BaseTool } from './types';
import type { PermissionService } from '../permission';
import type { LSPClient } from '../lsp/client';
import { ViewTool } from './view';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { LsTool } from './ls';
import { EditTool } from './edit';
import { WriteTool } from './write';
import { BashTool } from './bash';
import { FetchTool } from './fetch';
import { ApplyPatchTool } from './applyPatch';
import { TodoWriteTool } from './todowrite';
import { MemoryTool } from './memory';
import { QuestionTool } from './question';
import { DiagnosticsTool } from './diagnostics';
import { SourcegraphTool } from './sourcegraph';
import { TaskTool } from './task';
import { ExitPlanTool } from './exitPlan';
import { BashOutputTool, KillShellTool } from './backgroundShells';
import { WebSearchTool } from './websearch';
import type { AgentService } from '../agent';

export function createAllTools(
  permissions: PermissionService,
  lspClients?: Map<string, LSPClient>,
  agentService?: AgentService,
): BaseTool[] {
  const tools: BaseTool[] = [
    new ViewTool(permissions),
    new GlobTool(),
    new GrepTool(),
    new LsTool(),
    new EditTool(permissions),
    new WriteTool(permissions),
    new BashTool(permissions),
    new FetchTool(permissions),
    new ApplyPatchTool(permissions),
    new TodoWriteTool(),
    new MemoryTool(),
    new QuestionTool(),
    new SourcegraphTool(),
    new WebSearchTool(),
    new BashOutputTool(),
    new KillShellTool(),
  ];

  if (lspClients && lspClients.size > 0) {
    tools.push(new DiagnosticsTool(lspClients));
  }

  if (agentService) {
    tools.push(new TaskTool(agentService));
    tools.push(new ExitPlanTool(permissions, agentService));
  }

  return tools;
}
