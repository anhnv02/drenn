import type { ToolCall } from '../tools/types';

const XML_OPEN = '<tool_call';
const XML_CLOSE = '</tool_call>';
const SECTION_OPEN = '<|tool_calls_section_begin|>';
const SECTION_CLOSE = '<|tool_calls_section_end|>';
const CALL_OPEN = '<|tool_call_begin|>';
const CALL_CLOSE = '<|tool_call_end|>';
const MINIMAX_OPEN = '<minimax:tool_call';
const MINIMAX_CLOSE = '</minimax:tool_call>';

const FORMATS = [
  { open: XML_OPEN, close: XML_CLOSE },
  { open: SECTION_OPEN, close: SECTION_CLOSE },
  { open: CALL_OPEN, close: CALL_CLOSE },
  { open: MINIMAX_OPEN, close: MINIMAX_CLOSE },
] as const;

export interface FilterResult {
  text: string;
  calls: ToolCall[];
}

function partialTagSuffix(text: string, tag: string): number {
  const max = Math.min(text.length, tag.length - 1);
  for (let k = max; k > 0; k--) {
    if (text.endsWith(tag.slice(0, k))) return k;
  }
  return 0;
}

function isPlausibleToolName(name: string): boolean {
  return /[a-zA-Z0-9]/.test(name);
}

function coerceValue(value: string): unknown {
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value.startsWith('{') || value.startsWith('[')) {
    try {
      return JSON.parse(value);
    } catch {}
  }
  return value;
}

export class TextToolCallFilter {
  private buffer = '';
  private seq = 0;

  push(delta: string): FilterResult {
    this.buffer += delta;
    return this.drain(false);
  }

  flush(): FilterResult {
    const out = this.drain(true);
    const rest = this.buffer;
    this.buffer = '';
    if (rest) {
      const calls = this.parseBlock(rest);
      if (calls.length > 0) {
        out.calls.push(...calls);
      } else {
        out.text += rest;
      }
    }
    return out;
  }

  private drain(final: boolean): FilterResult {
    let text = '';
    const calls: ToolCall[] = [];

    for (;;) {
      let start = -1;
      let format: (typeof FORMATS)[number] | undefined;
      for (const candidate of FORMATS) {
        const index = this.buffer.indexOf(candidate.open);
        if (index !== -1 && (start === -1 || index < start)) {
          start = index;
          format = candidate;
        }
      }

      if (start === -1 || !format) {
        let hold = 0;
        if (!final) {
          for (const candidate of FORMATS) {
            hold = Math.max(hold, partialTagSuffix(this.buffer, candidate.open));
          }
        }
        text += this.buffer.slice(0, this.buffer.length - hold);
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        break;
      }

      text += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start);

      const end = this.buffer.indexOf(format.close);
      if (end === -1) break;

      const block = this.buffer.slice(0, end + format.close.length);
      this.buffer = this.buffer.slice(end + format.close.length);
      const parsed = this.parseBlock(block);
      if (parsed.length > 0) {
        calls.push(...parsed);
      } else {
        text += block;
      }
    }

    return { text, calls };
  }

  private parseBlock(block: string): ToolCall[] {
    if (block.includes(CALL_OPEN) || block.includes(SECTION_OPEN)) {
      return this.parseTokenCalls(block);
    }
    if (block.includes(MINIMAX_OPEN)) {
      return this.parseMinimaxCalls(block);
    }
    const call = this.parseXmlBlock(block);
    return call ? [call] : [];
  }

  private parseMinimaxCalls(block: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const invokeRe = /<invoke\s+name="?([^">\s]+)"?\s*>/g;
    const invokes: Array<{ name: string; bodyStart: number; tagStart: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = invokeRe.exec(block))) {
      if (!isPlausibleToolName(m[1])) continue;
      invokes.push({ name: m[1], bodyStart: m.index + m[0].length, tagStart: m.index });
    }

    invokes.forEach((inv, i) => {
      const rawEnd = i + 1 < invokes.length ? invokes[i + 1].tagStart : block.length;
      let body = block.slice(inv.bodyStart, rawEnd);
      const close = body.search(/<\/invoke>|<\/minimax:tool_call>/);
      if (close !== -1) body = body.slice(0, close);

      const args: Record<string, unknown> = {};
      const paramRe = /<parameter\s+name="?([^">\s]+)"?\s*>/g;
      const params: Array<{ key: string; valueStart: number; tagStart: number }> = [];
      let p: RegExpExecArray | null;
      while ((p = paramRe.exec(body))) {
        params.push({ key: p[1], valueStart: p.index + p[0].length, tagStart: p.index });
      }
      params.forEach((param, j) => {
        const valueEnd = j + 1 < params.length ? params[j + 1].tagStart : body.length;
        let value = body.slice(param.valueStart, valueEnd);
        const valueClose = value.search(/<\/(parameter|invoke)>/);
        if (valueClose !== -1) value = value.slice(0, valueClose);
        args[param.key] = coerceValue(value.trim());
      });

      calls.push({
        id: `text-tc-${Date.now()}-${this.seq++}`,
        name: inv.name,
        input: JSON.stringify(args),
      });
    });

    return calls;
  }

  private parseTokenCalls(block: string): ToolCall[] {
    const calls: ToolCall[] = [];
    const re =
      /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*(?=<\|tool_call_end\|>|<\|tool_call_begin\|>|<\|tool_calls_section_end\|>|$)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      const name = m[1]
        .replace(/^functions\./, '')
        .replace(/:\d+$/, '')
        .trim();
      if (!name || !isPlausibleToolName(name)) continue;
      const args = m[2].trim();
      calls.push({
        id: `text-tc-${Date.now()}-${this.seq++}`,
        name,
        input: args || '{}',
      });
    }
    return calls;
  }

  private parseXmlBlock(block: string): ToolCall | null {
    const fn = /<function=([^>\s]+)\s*>/.exec(block);
    if (!fn || !isPlausibleToolName(fn[1])) return null;

    const args: Record<string, unknown> = {};
    const paramRe = /<parameter=([^>\s]+)\s*>/g;
    const params: Array<{ key: string; valueStart: number; tagStart: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = paramRe.exec(block))) {
      params.push({ key: m[1], valueStart: m.index + m[0].length, tagStart: m.index });
    }

    params.forEach((p, i) => {
      const rawEnd = i + 1 < params.length ? params[i + 1].tagStart : block.length;
      let value = block.slice(p.valueStart, rawEnd);
      const close = value.search(/<\/(parameter|function|tool_call)>/);
      if (close !== -1) value = value.slice(0, close);
      args[p.key] = coerceValue(value.trim());
    });

    return {
      id: `text-tc-${Date.now()}-${this.seq++}`,
      name: fn[1],
      input: JSON.stringify(args),
    };
  }
}
