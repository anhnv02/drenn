import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { deniedToolResult, type PermissionService } from '../permission';
import { parseToolInput } from '../../shared/utils/json';

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT = 60000;
const MAX_REDIRECTS = 5;

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateIPv4(ip);
  const lower = ip.toLowerCase();
  if (lower === '::' || lower === '::1') return true;
  if (lower.startsWith('::ffff:')) {
    const rest = lower.slice('::ffff:'.length);
    if (rest.includes('.')) return isPrivateIPv4(rest);
    const groups = rest.split(':').map((g) => parseInt(g, 16));
    if (groups.length === 2 && groups.every((n) => !Number.isNaN(n))) {
      return isPrivateIPv4(
        `${(groups[0] >> 8) & 255}.${groups[0] & 255}.${(groups[1] >> 8) & 255}.${groups[1] & 255}`,
      );
    }
    return true;
  }
  return /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
}

async function isPrivateHost(hostname: string): Promise<boolean> {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    return true;
  }
  if (isIP(host)) return isPrivateIp(host);
  try {
    const addrs = await lookup(host, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return false;
  }
}

export class FetchTool implements BaseTool {
  private permissions: PermissionService;

  constructor(permissions: PermissionService) {
    this.permissions = permissions;
  }

  info(): ToolInfo {
    return {
      name: 'fetch',
      description: `Fetches content from an HTTP/HTTPS URL and returns it (markdown by default). ALWAYS use this instead of bash curl/wget for web content. Cannot fetch binary content; responses over 5MB are rejected.`,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'URL to fetch (http:// or https://)',
          },
          format: {
            type: 'string',
            enum: ['text', 'markdown', 'html'],
            description: 'Output format (default: markdown)',
          },
          timeout: {
            type: 'number',
            description: 'Timeout in milliseconds (default: 60000)',
          },
        },
        required: ['url'],
      },
      required: ['url'],
    };
  }

  async run(ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    try {
      const params = parseToolInput<{
        url?: string;
        format?: string;
        timeout?: number;
      }>(call.input, { format: 'markdown', timeout: DEFAULT_TIMEOUT });
      const { url, format = 'markdown', timeout = DEFAULT_TIMEOUT } = params;

      if (!url) {
        return { content: 'Error: url is required', isError: true };
      }

      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return { content: `Error: Invalid URL: ${url}`, isError: true };
      }

      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        return { content: 'Error: Only HTTP/HTTPS URLs are allowed', isError: true };
      }

      if (await isPrivateHost(parsedUrl.hostname)) {
        return {
          content: 'Error: Fetching internal/private network addresses is not allowed',
          isError: true,
        };
      }

      if (ctx.mode !== 'bypassPermissions') {
        const decision = await this.permissions.request({
          id: call.id,
          sessionId: ctx.sessionId,
          messageId: ctx.messageId,
          toolName: 'fetch',
          action: 'fetch',
          description: `Fetch ${url}`,
          params: { url, format },
          resource: parsedUrl.href,
          cwd: ctx.cwd,
        });

        if (!decision.approved) {
          return { content: deniedToolResult(decision.feedback), isError: true };
        }
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        let currentUrl = parsedUrl;
        let response: Response;
        let redirects = 0;
        for (;;) {
          response = await fetch(currentUrl.href, {
            signal: controller.signal,
            redirect: 'manual',
            headers: {
              'User-Agent': 'drenn-agent/1.0',
            },
          });

          const location = response.headers.get('location');
          if (response.status < 300 || response.status >= 400 || !location) break;

          if (++redirects > MAX_REDIRECTS) {
            return { content: `Error: Too many redirects (max ${MAX_REDIRECTS})`, isError: true };
          }
          currentUrl = new URL(location, currentUrl);
          if (!['http:', 'https:'].includes(currentUrl.protocol)) {
            return {
              content: `Error: Redirected to a non-HTTP URL (${currentUrl.protocol})`,
              isError: true,
            };
          }
          if (await isPrivateHost(currentUrl.hostname)) {
            return {
              content:
                'Error: Redirected to an internal/private network address, refusing to follow',
              isError: true,
            };
          }
        }

        if (!response.ok) {
          return {
            content: `Error: HTTP ${response.status} ${response.statusText}`,
            isError: true,
          };
        }

        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('image/') || contentType.includes('application/octet-stream')) {
          return { content: `Error: Cannot fetch binary content (${contentType})`, isError: true };
        }

        const text = await response.text();

        if (text.length > MAX_RESPONSE_SIZE) {
          return {
            content: `Error: Response too large (${(text.length / 1024 / 1024).toFixed(1)}MB). Max: 5MB`,
            isError: true,
          };
        }

        let output: string;
        if (format === 'html') {
          output = text;
        } else if (format === 'text') {
          output = stripHtml(text);
        } else {
          output = htmlToMarkdown(text);
        }

        return { content: output, isError: false };
      } catch (fetchError) {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') {
          return { content: `Error: Request timed out after ${timeout}ms`, isError: true };
        }
        throw fetchError;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (error) {
      return { content: `Error fetching URL: ${error}`, isError: true };
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function htmlToMarkdown(html: string): string {
  let md = html;
  md = md.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  md = md.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  md = md.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '# $1\n\n');
  md = md.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '## $1\n\n');
  md = md.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '### $1\n\n');
  md = md.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n');
  md = md.replace(/<br\s*\/?>/gi, '\n');
  md = md.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  md = md.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  md = md.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, '```\n$1\n```\n');
  md = md.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  md = md.replace(/<[^>]+>/g, '');
  md = md.replace(/&nbsp;/g, ' ');
  md = md.replace(/</g, '<');
  md = md.replace(/>/g, '>');
  md = md.replace(/&/g, '&');
  md = md.replace(/\n{3,}/g, '\n\n');
  return md.trim();
}
