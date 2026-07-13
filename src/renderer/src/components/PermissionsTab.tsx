import { useEffect, useState } from 'react';
import { api } from '../api';
import { Codicon } from './Codicon';
import type { PermissionRule } from '../../../shared/types';

export function PermissionsTab() {
  const [rules, setRules] = useState<PermissionRule[]>([]);

  useEffect(() => {
    api.getPermissionRules().then(({ rules }) => setRules(rules));
  }, []);

  async function removeRule(key: string) {
    await api.deletePermissionRule(key);
    setRules((prev) => prev.filter((r) => r.key !== key));
  }

  return (
    <div className="pr-body">
      {rules.length === 0 ? (
        <div className="pr-empty">
          No saved rules. Choosing “Always allow” on a permission dialog adds one here, scoped to
          the project it was approved in.
        </div>
      ) : (
        rules.map((rule) => (
          <div className="pr-rule" key={rule.key}>
            <span className="pr-rule-tool">{rule.toolName}</span>
            <span
              className="pr-rule-resource"
              title={`${rule.value}${rule.kind === 'prefix' ? ' …' : ''} — ${rule.cwd}`}
            >
              {rule.value}
              {rule.kind === 'prefix' ? ' …' : ''}
            </span>
            <button
              type="button"
              className="icon-btn"
              title="Revoke this rule"
              onClick={() => removeRule(rule.key)}
            >
              <Codicon name="trash" size={14} />
            </button>
          </div>
        ))
      )}
    </div>
  );
}
