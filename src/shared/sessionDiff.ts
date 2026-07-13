import type { EditOp } from './types';

export function stitchDoc(texts: string[]): string {
  if (texts.length === 1) return texts[0];
  return texts.map((t, i) => `··· edit ${i + 1} of ${texts.length} ···\n${t}`).join('\n\n');
}

export function buildSessionDiff(ops: EditOp[]): { before: string; after: string } | null {
  if (!ops.length) return null;
  return {
    before: stitchDoc(ops.map((op) => op.before)),
    after: stitchDoc(ops.map((op) => op.after)),
  };
}
