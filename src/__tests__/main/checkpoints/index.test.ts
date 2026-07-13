import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { recordCheckpoint, listCheckpoints, revertSessionChanges } from '../../../main/checkpoints';

const settle = () => new Promise((r) => setTimeout(r, 50));

describe('checkpoints', () => {
  it('reverts an edited file to its pre-session content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-cp-'));
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'original');

    const sessionId = `local:cp-${Date.now()}`;
    recordCheckpoint(sessionId, 'edit', file, 'original');
    writeFileSync(file, 'changed once');
    recordCheckpoint(sessionId, 'edit', file, 'changed once');
    writeFileSync(file, 'changed twice');
    await settle();

    const list = await listCheckpoints(sessionId);
    expect(list).toHaveLength(2);
    expect(list[0].existed).toBe(true);

    const report = await revertSessionChanges(sessionId);
    expect(report).toEqual([{ filePath: file, action: 'restored' }]);
    expect(readFileSync(file, 'utf8')).toBe('original');

    expect(await listCheckpoints(sessionId)).toHaveLength(0);
  });

  it('deletes files the session created', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'drenn-cp-'));
    const file = join(dir, 'new.txt');

    const sessionId = `local:cp-new-${Date.now()}`;
    recordCheckpoint(sessionId, 'write', file, null);
    writeFileSync(file, 'created by session');
    await settle();

    const report = await revertSessionChanges(sessionId);
    expect(report).toEqual([{ filePath: file, action: 'deleted' }]);
    expect(existsSync(file)).toBe(false);
  });

  it('reverting an untouched session is a no-op', async () => {
    const report = await revertSessionChanges(`local:cp-none-${Date.now()}`);
    expect(report).toEqual([]);
  });
});
