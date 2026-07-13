import { describe, it, expect } from 'vitest';
import {
  fromConfig,
  merge,
  evaluatePermission,
  type PermissionConfig,
  type PermissionRuleset,
} from '../../../main/permission/ruleset';

describe('fromConfig', () => {
  it('converts string action to wildcard pattern', () => {
    const config: PermissionConfig = { read: 'allow' };
    const rules = fromConfig(config);
    expect(rules).toEqual([{ permission: 'read', pattern: '*', action: 'allow' }]);
  });

  it('converts nested object to pattern rules', () => {
    const config: PermissionConfig = {
      edit: { '*.ts': 'allow', '*.test.ts': 'deny' },
    };
    const rules = fromConfig(config);
    expect(rules).toHaveLength(2);
    expect(rules[0]).toEqual({ permission: 'edit', pattern: '*.ts', action: 'allow' });
    expect(rules[1]).toEqual({ permission: 'edit', pattern: '*.test.ts', action: 'deny' });
  });

  it('handles mixed string and object entries', () => {
    const config: PermissionConfig = {
      read: 'allow',
      write: { '*': 'deny' },
    };
    const rules = fromConfig(config);
    expect(rules).toHaveLength(2);
  });

  it('returns empty array for empty config', () => {
    expect(fromConfig({})).toEqual([]);
  });
});

describe('merge', () => {
  it('merges multiple rulesets', () => {
    const a: PermissionRuleset = [{ permission: 'read', pattern: '*', action: 'allow' }];
    const b: PermissionRuleset = [{ permission: 'write', pattern: '*', action: 'deny' }];
    const merged = merge(a, b);
    expect(merged).toHaveLength(2);
  });

  it('returns empty for no arguments', () => {
    expect(merge()).toEqual([]);
  });

  it('preserves order', () => {
    const a: PermissionRuleset = [{ permission: 'a', pattern: '*', action: 'allow' }];
    const b: PermissionRuleset = [{ permission: 'b', pattern: '*', action: 'deny' }];
    const merged = merge(a, b);
    expect(merged[0].permission).toBe('a');
    expect(merged[1].permission).toBe('b');
  });
});

describe('evaluatePermission', () => {
  it('returns null for empty ruleset', () => {
    expect(evaluatePermission([], 'read', 'file.ts')).toBeNull();
  });

  it('matches wildcard permission and pattern', () => {
    const rules: PermissionRuleset = [{ permission: '*', pattern: '*', action: 'allow' }];
    expect(evaluatePermission(rules, 'read', 'anything')).toBe('allow');
  });

  it('matches specific permission with wildcard pattern', () => {
    const rules: PermissionRuleset = [{ permission: 'read', pattern: '*', action: 'allow' }];
    expect(evaluatePermission(rules, 'read', 'file.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'write', 'file.ts')).toBeNull();
  });

  it('matches glob pattern on resource', () => {
    const rules: PermissionRuleset = [{ permission: 'edit', pattern: '*.ts', action: 'allow' }];
    expect(evaluatePermission(rules, 'edit', 'foo.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'edit', 'foo.js')).toBeNull();
  });

  it('last matching rule wins', () => {
    const rules: PermissionRuleset = [
      { permission: 'edit', pattern: '*', action: 'allow' },
      { permission: 'edit', pattern: '*.test.ts', action: 'deny' },
    ];
    expect(evaluatePermission(rules, 'edit', 'foo.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'edit', 'foo.test.ts')).toBe('deny');
  });

  it('matches ** globstar pattern', () => {
    const rules: PermissionRuleset = [
      { permission: 'read', pattern: 'src/**/*.ts', action: 'allow' },
    ];
    expect(evaluatePermission(rules, 'read', 'src/main/index.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'read', 'src/main/deep/file.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'read', 'lib/index.ts')).toBeNull();
  });

  it('matches ? single char wildcard', () => {
    const rules: PermissionRuleset = [{ permission: 'read', pattern: 'file?.ts', action: 'allow' }];
    expect(evaluatePermission(rules, 'read', 'file1.ts')).toBe('allow');
    expect(evaluatePermission(rules, 'read', 'fileAB.ts')).toBeNull();
  });
});
