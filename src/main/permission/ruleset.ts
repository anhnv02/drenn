export type PermissionAction = 'allow' | 'ask' | 'deny';

export interface PermissionRule {
  permission: string;
  pattern: string;
  action: PermissionAction;
}

export type PermissionRuleset = PermissionRule[];

export interface PermissionConfig {
  [permission: string]: PermissionAction | Record<string, PermissionAction>;
}

export function fromConfig(config: PermissionConfig): PermissionRuleset {
  const rules: PermissionRuleset = [];

  for (const [permission, value] of Object.entries(config)) {
    if (typeof value === 'string') {
      rules.push({
        permission,
        pattern: '*',
        action: value,
      });
    } else if (typeof value === 'object') {
      for (const [pattern, action] of Object.entries(value)) {
        rules.push({
          permission,
          pattern,
          action,
        });
      }
    }
  }

  return rules;
}

export function merge(...rulesets: PermissionRuleset[]): PermissionRuleset {
  const merged: PermissionRuleset = [];
  for (const ruleset of rulesets) {
    merged.push(...ruleset);
  }
  return merged;
}

export function evaluatePermission(
  ruleset: PermissionRuleset,
  permission: string,
  resource: string,
): PermissionAction | null {
  let result: PermissionAction | null = null;

  for (const rule of ruleset) {
    if (rule.permission === permission || rule.permission === '*') {
      if (rule.pattern === '*' || matchResourcePattern(rule.pattern, resource)) {
        result = rule.action;
      }
    }
  }

  return result;
}

function matchResourcePattern(pattern: string, resource: string): boolean {
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<GLOBSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
    .replace(/<<GLOBSTAR>>/g, '.*');

  const regex = new RegExp(`^${regexPattern}$`, 'i');
  return regex.test(resource);
}
