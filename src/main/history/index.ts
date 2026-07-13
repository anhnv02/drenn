import type { EditOp, FileChange, ProjectGroup, Session, Transcript } from '../../shared/types';
import { access } from 'node:fs/promises';
import {
  listClaudeCodeSessions,
  getClaudeCodeTranscript,
  getClaudeCodeCwd,
  getClaudeCodeChanges,
  getClaudeCodeFileOps,
} from './claudeCode';
import {
  listOpencodeSessions,
  getOpencodeTranscript,
  getOpencodeCwd,
  getOpencodeChanges,
  getOpencodeFileOps,
} from './opencode';
import {
  listCopilotSessions,
  getCopilotTranscript,
  getCopilotCwd,
  getCopilotChanges,
} from './copilot';
import {
  getLocalSessions,
  getLocalSessionCwd,
  getLocalTranscript,
  getLocalChanges,
  getLocalFileOps,
} from '../session/localSessions';
import {
  isContinuableSession,
  getContinuationSteps,
  getContinuationChanges,
  getContinuationFileOps,
  getContinuationStats,
} from '../session/continuations';

export async function getProjects(): Promise<{
  projects: ProjectGroup[];
  activeSessionId: string | null;
}> {
  const [claudeSessions, opencodeSessions, copilotSessions] = await Promise.all([
    listClaudeCodeSessions().catch(() => []),
    listOpencodeSessions().catch(() => []),
    listCopilotSessions().catch(() => []),
  ]);
  const allSessions: Session[] = [
    ...claudeSessions,
    ...opencodeSessions,
    ...copilotSessions,
    ...getLocalSessions(),
  ];

  const continuationStats = await getContinuationStats();
  for (const session of allSessions) {
    const extra = continuationStats.get(session.id);
    if (!extra) continue;
    session.added += extra.added;
    session.removed += extra.removed;
    if (extra.updatedAt > session.updatedAt) session.updatedAt = extra.updatedAt;
  }

  const byProject = new Map<string, Session[]>();
  for (const session of allSessions) {
    const list = byProject.get(session.projectName) ?? [];
    list.push(session);
    byProject.set(session.projectName, list);
  }

  const projects: ProjectGroup[] = [...byProject.entries()]
    .map(([name, sessions]) => ({
      name,
      sessions: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
    .sort((a, b) => b.sessions[0].updatedAt.localeCompare(a.sessions[0].updatedAt));

  const activeSessionId = projects[0]?.sessions[0]?.id ?? null;

  return { projects, activeSessionId };
}

export async function getTranscript(sessionId: string): Promise<Transcript> {
  if (sessionId.startsWith('local:'))
    return { sessionId, steps: await getLocalTranscript(sessionId) };

  let base: Transcript;
  if (sessionId.startsWith('opencode:')) base = await getOpencodeTranscript(sessionId);
  else if (sessionId.startsWith('copilot:')) base = await getCopilotTranscript(sessionId);
  else if (sessionId.startsWith('claude:')) base = await getClaudeCodeTranscript(sessionId);
  else return { sessionId, steps: [] };

  const continued = await getContinuationSteps(sessionId);
  return continued.length ? { ...base, steps: [...base.steps, ...continued] } : base;
}

async function validateCwd(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    await access(cwd);
    return cwd;
  } catch {
    return null;
  }
}

export async function getSessionCwd(sessionId: string): Promise<string | null> {
  if (sessionId.startsWith('local:')) return validateCwd(await getLocalSessionCwd(sessionId));
  if (sessionId.startsWith('opencode:')) return validateCwd(await getOpencodeCwd(sessionId));
  if (sessionId.startsWith('copilot:')) return validateCwd(await getCopilotCwd(sessionId));
  if (sessionId.startsWith('claude:')) return validateCwd(await getClaudeCodeCwd(sessionId));
  return null;
}

export async function getSessionChanges(sessionId: string): Promise<FileChange[]> {
  if (sessionId.startsWith('local:')) return getLocalChanges(sessionId);

  let base: FileChange[];
  if (sessionId.startsWith('opencode:')) base = await getOpencodeChanges(sessionId);
  else if (sessionId.startsWith('claude:')) base = await getClaudeCodeChanges(sessionId);
  else if (sessionId.startsWith('copilot:')) base = await getCopilotChanges(sessionId);
  else return [];

  const continued = await getContinuationChanges(sessionId, await getSessionCwd(sessionId));
  return continued.length ? mergeFileChanges(base, continued) : base;
}

function mergeFileChanges(base: FileChange[], extra: FileChange[]): FileChange[] {
  const byPath = new Map<string, FileChange>();
  for (const change of [...base, ...extra]) {
    const existing = byPath.get(change.path);
    if (existing) {
      existing.added += change.added;
      existing.removed += change.removed;
    } else {
      byPath.set(change.path, { ...change });
    }
  }
  return [...byPath.values()];
}

export async function getSessionFileOps(sessionId: string, path: string): Promise<EditOp[] | null> {
  if (sessionId.startsWith('local:')) return getLocalFileOps(sessionId, path);

  let base: EditOp[] | null = null;
  if (sessionId.startsWith('opencode:')) base = await getOpencodeFileOps(sessionId, path);
  else if (sessionId.startsWith('claude:')) base = await getClaudeCodeFileOps(sessionId, path);
  else if (!isContinuableSession(sessionId)) return null;

  const continued = await getContinuationFileOps(sessionId, path, await getSessionCwd(sessionId));
  if (!continued) return base;
  return [...(base ?? []), ...continued];
}
