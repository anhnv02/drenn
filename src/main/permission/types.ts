export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRequest {
  id: string;
  sessionId: string;
  messageId: string;
  toolName: string;
  action: string;
  path?: string;
  description: string;
  params?: Record<string, any>;
  diff?: string;
  resource: string;
  cwd: string;
  external?: boolean;
  autoApprove?: boolean;
}

export interface PermissionResponse {
  requestId: string;
  approved: boolean;
  remember: boolean;
  rememberPrefix?: string;
  feedback?: string;
  updatedMode?: 'default' | 'acceptEdits';
}

export interface PermissionDecision {
  approved: boolean;
  feedback?: string;
  updatedMode?: 'default' | 'acceptEdits';
}

export function deniedToolResult(feedback?: string): string {
  const base = "The user doesn't want to proceed with this tool use. The tool use was rejected.";
  return feedback
    ? `${base} The user provided the following feedback:\n<user_feedback>\n${feedback}\n</user_feedback>`
    : base;
}

export interface PermissionService {
  request(req: PermissionRequest): Promise<PermissionDecision>;
  handleResponse(response: PermissionResponse): void;
  cancelPendingPermissions(sessionId: string): void;
}
