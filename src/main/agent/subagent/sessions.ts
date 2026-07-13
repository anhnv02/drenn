import type { PermissionRuleset } from '../../permission/ruleset';
import { merge } from '../../permission/ruleset';
import { deriveSubagentSessionPermission } from './permissions';
import type { SubAgentConfig } from './types';

export interface AgentSession {
  id: string;
  parentId?: string;
  agentName: string;
  title: string;
  permission: PermissionRuleset;
  createdAt: number;
  status: 'active' | 'completed' | 'error';
}

export class SessionManager {
  private sessions = new Map<string, AgentSession>();

  createSession(
    sessionId: string,
    agentName: string,
    title: string,
    parentSession?: AgentSession,
    subagentConfig?: SubAgentConfig,
  ): AgentSession {
    let permission: PermissionRuleset = [];

    if (parentSession && subagentConfig) {
      // Derive permission from parent
      permission = deriveSubagentSessionPermission({
        parentSessionPermission: parentSession.permission,
        subagent: subagentConfig,
      });
    }

    const session: AgentSession = {
      id: sessionId,
      parentId: parentSession?.id,
      agentName,
      title,
      permission,
      createdAt: Date.now(),
      status: 'active',
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  getParentSession(sessionId: string): AgentSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session?.parentId) {
      return this.sessions.get(session.parentId);
    }
    return undefined;
  }

  getChildSessions(parentId: string): AgentSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.parentId === parentId);
  }

  updateSessionStatus(sessionId: string, status: 'active' | 'completed' | 'error'): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.status = status;
    }
  }

  deleteSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  listSessions(): AgentSession[] {
    return Array.from(this.sessions.values());
  }
}

export const sessionManager = new SessionManager();
