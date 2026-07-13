import { splitCommandSegments, hasFileRedirect } from '../tools/readOnlyCommands';

export interface PermissionPattern {
  pattern: string;
  action: 'allow' | 'ask' | 'deny';
}

export function matchPattern(pattern: string, value: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(value);
}

export function checkPermissionPatterns(
  patterns: PermissionPattern[],
  toolName: string,
  resource: string,
): 'allow' | 'ask' | 'deny' | null {
  for (const { pattern, action } of patterns) {
    if (matchPattern(pattern, toolName + ' ' + resource)) {
      return action;
    }
  }
  return null;
}

export function evaluateBashPatterns(
  patterns: PermissionPattern[],
  command: string,
): 'allow' | 'ask' | 'deny' | null {
  const segments = splitCommandSegments(command);
  if (segments.length === 0) return null;

  let sawAsk = false;
  let allAllowed = true;
  for (const segment of segments) {
    let action: 'allow' | 'ask' | 'deny' | null = null;
    for (const { pattern, action: ruleAction } of patterns) {
      if (matchPattern(pattern, segment)) {
        action = ruleAction;
        break;
      }
    }
    if (action === 'deny') return 'deny';
    if (action === 'ask') sawAsk = true;
    if (action !== 'allow') allAllowed = false;
  }
  if (sawAsk) return 'ask';
  if (allAllowed && !hasFileRedirect(command)) return 'allow';
  return null;
}
