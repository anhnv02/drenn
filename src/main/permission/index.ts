import type { BrowserWindow } from 'electron';
import { IPC } from '../../shared/ipc';
import type { PermissionRule, PermissionPatternRule } from '../../shared/types';
import type {
  PermissionDecision,
  PermissionRequest,
  PermissionResponse,
  PermissionService,
} from './types';
import { matchPattern, evaluateBashPatterns } from './patterns';
import { splitCommandSegments, hasFileRedirect } from '../tools/readOnlyCommands';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runHooks } from '../hooks';
import { parseJsonSafe } from '../../shared/utils/json';

export type { PermissionService, PermissionDecision } from './types';
export { deniedToolResult } from './types';
export type { PermissionRuleset, PermissionAction, PermissionConfig } from './ruleset';
export { fromConfig, merge, evaluatePermission } from './ruleset';

let mainWindow: BrowserWindow | null = null;

export function setPermissionWindow(window: BrowserWindow): void {
  mainWindow = window;
  permissionService.resendPendingRequests();
}

interface RememberedRule {
  cwd: string;
  toolName: string;
  kind: 'exact' | 'prefix';
  value: string;
}

function ruleToKey(rule: RememberedRule): string {
  return [rule.kind, rule.cwd, rule.toolName, rule.value].join('::');
}

export class PermissionServiceImpl implements PermissionService {
  private rememberedRules: RememberedRule[] = [];
  private pendingRequests = new Map<
    string,
    {
      resolve: (decision: PermissionDecision) => void;
      request: PermissionRequest;
    }
  >();
  private patternRules: PermissionPatternRule[] = [];
  private rulesPath: string;
  private ready: Promise<void>;

  constructor() {
    this.rulesPath = join(homedir(), '.config', 'drenn', 'permission-rules.json');
    this.ready = this.loadRules();
  }

  private async loadRules(): Promise<void> {
    try {
      const data = await readFile(this.rulesPath, 'utf8');
      const rules = parseJsonSafe(data);
      if (!Array.isArray(rules)) return;
      this.rememberedRules = rules.filter(
        (r): r is RememberedRule =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as RememberedRule).cwd === 'string' &&
          typeof (r as RememberedRule).toolName === 'string' &&
          typeof (r as RememberedRule).value === 'string' &&
          ((r as RememberedRule).kind === 'exact' || (r as RememberedRule).kind === 'prefix'),
      );
    } catch {
      // File doesn't exist or invalid - start with empty rules
    }
  }

  private async saveRules(): Promise<void> {
    try {
      await mkdir(join(homedir(), '.config', 'drenn'), { recursive: true });
      await writeFile(this.rulesPath, JSON.stringify(this.rememberedRules), 'utf8');
    } catch {
      // Ignore save errors
    }
  }

  private matchesRemembered(req: PermissionRequest): boolean {
    const rules = this.rememberedRules.filter(
      (r) => r.cwd === req.cwd && r.toolName === req.toolName,
    );
    if (rules.some((r) => r.kind === 'exact' && r.value === req.resource)) {
      return true;
    }
    const prefixes = rules.filter((r) => r.kind === 'prefix');
    if (prefixes.length === 0) return false;

    if (req.toolName === 'bash') {
      if (hasFileRedirect(req.resource)) return false;
      const segments = splitCommandSegments(req.resource);
      if (segments.length === 0) return false;
      return segments.every((seg) =>
        prefixes.some((p) => seg === p.value || seg.startsWith(p.value + ' ')),
      );
    }
    return prefixes.some((p) => req.resource.startsWith(p.value));
  }

  async request(req: PermissionRequest): Promise<PermissionDecision> {
    await this.ready;

    if (this.matchesRemembered(req)) {
      return { approved: true };
    }

    const patternResult = this.checkPatterns(req.toolName, req.resource);
    if (patternResult === 'allow') {
      return { approved: true };
    }
    if (patternResult === 'deny') {
      return { approved: false };
    }

    const hook = await runHooks('PermissionRequest', {
      session_id: req.sessionId,
      cwd: req.cwd,
      tool_name: req.toolName,
      tool_input: req.params,
      resource: req.resource,
    });
    if (hook.blocked) {
      return { approved: false, feedback: hook.feedback };
    }

    if (req.autoApprove && patternResult !== 'ask') {
      return { approved: true };
    }

    void runHooks('Notification', {
      session_id: req.sessionId,
      cwd: req.cwd,
      message: `Permission required: ${req.toolName} — ${req.description}`,
    });

    return new Promise<PermissionDecision>((resolve) => {
      this.pendingRequests.set(req.id, { resolve, request: req });
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.permissionRequest, req);
      }
    });
  }

  private checkPatterns(toolName: string, resource: string): 'allow' | 'ask' | 'deny' | null {
    if (toolName !== 'bash') {
      for (const { pattern, action } of this.patternRules) {
        if (matchPattern(pattern, `${toolName} ${resource}`)) {
          return action;
        }
      }
      return null;
    }

    return evaluateBashPatterns(this.patternRules, resource);
  }

  loadPatternRules(rules: PermissionPatternRule[]): void {
    this.patternRules = rules;
  }

  private static readonly NEVER_REMEMBER = new Set(['exit_plan', 'apply_patch']);

  handleResponse(response: PermissionResponse): void {
    const pending = this.pendingRequests.get(response.requestId);
    if (pending) {
      if (
        response.remember &&
        response.approved &&
        !PermissionServiceImpl.NEVER_REMEMBER.has(pending.request.toolName)
      ) {
        const rule: RememberedRule = {
          cwd: pending.request.cwd,
          toolName: pending.request.toolName,
          kind: response.rememberPrefix ? 'prefix' : 'exact',
          value: response.rememberPrefix ?? pending.request.resource,
        };
        if (!this.rememberedRules.some((r) => ruleToKey(r) === ruleToKey(rule))) {
          this.rememberedRules.push(rule);
          this.saveRules();
        }
      }
      pending.resolve({
        approved: response.approved,
        feedback: response.feedback,
        updatedMode: response.updatedMode,
      });
      this.pendingRequests.delete(response.requestId);
    }
  }

  cancelPendingPermissions(sessionId: string): void {
    const ids = [...this.pendingRequests.entries()]
      .filter(([, entry]) => entry.request.sessionId === sessionId)
      .map(([id]) => id);
    for (const id of ids) {
      this.pendingRequests.get(id)!.resolve({ approved: false });
      this.pendingRequests.delete(id);
    }
    if (ids.length > 0 && mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(IPC.permissionClearSession, { sessionId });
    }
  }

  resendPendingRequests(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    for (const { request } of this.pendingRequests.values()) {
      mainWindow.webContents.send(IPC.permissionRequest, request);
    }
  }

  listRules(): PermissionRule[] {
    return this.rememberedRules.map((rule) => ({ key: ruleToKey(rule), ...rule }));
  }

  deleteRule(key: string): void {
    this.rememberedRules = this.rememberedRules.filter((r) => ruleToKey(r) !== key);
    this.saveRules();
  }
}

export const permissionService = new PermissionServiceImpl();
