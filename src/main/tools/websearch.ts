import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { parseToolInput } from '../../shared/utils/json';

const SEARCH_ENDPOINT = 'https://html.duckduckgo.com/html/';
const MAX_RESULTS = 8;
const TIMEOUT_MS = 15_000;

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#x?\d+;|&#\d+;/g, (m) => {
      const code = m.startsWith('&#x')
        ? parseInt(m.slice(3, -1), 16)
        : parseInt(m.slice(2, -1), 10);
      return Number.isFinite(code) ? String.fromCharCode(code) : m;
    });
}

function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveResultUrl(href: string): string {
  const m = href.match(/[?&]uddg=([^&]+)/);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return href;
    }
  }
  return href.startsWith('//') ? `https:${href}` : href;
}

export function parseSearchResults(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const linkRe = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  const snippets: string[] = [];
  for (let m = snippetRe.exec(html); m; m = snippetRe.exec(html)) {
    snippets.push(stripTags(m[1]));
  }

  let i = 0;
  for (let m = linkRe.exec(html); m && results.length < MAX_RESULTS; m = linkRe.exec(html), i++) {
    const url = resolveResultUrl(decodeEntities(m[1]));
    if (url.includes('duckduckgo.com/y.js')) continue;
    results.push({
      title: stripTags(m[2]),
      url,
      snippet: snippets[i] ?? '',
    });
  }
  return results;
}

export class WebSearchTool implements BaseTool {
  info(): ToolInfo {
    return {
      name: 'websearch',
      description: `Search the web and return the top results (title, URL, snippet). Use this to find current information, documentation, or error messages beyond your knowledge. To read a promising result in full, follow up with the fetch tool on its URL.`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query',
          },
        },
        required: ['query'],
      },
      required: ['query'],
    };
  }

  async run(_ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const params = parseToolInput<{
      query?: string;
    }>(call.input);
    const query = String(params.query ?? '').trim();
    if (!query) {
      return { content: 'Error: query is required', isError: true };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${SEARCH_ENDPOINT}?q=${encodeURIComponent(query)}`, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        return { content: `Error: search request failed (HTTP ${res.status})`, isError: true };
      }
      const html = await res.text();
      const results = parseSearchResults(html);
      if (results.length === 0) {
        return { content: `No results found for "${query}"`, isError: false };
      }
      const lines = results.map(
        (r, idx) => `${idx + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`,
      );
      return { content: lines.join('\n\n'), isError: false };
    } catch (error) {
      const message =
        error instanceof Error && error.name === 'AbortError'
          ? 'search timed out'
          : error instanceof Error
            ? error.message
            : String(error);
      return { content: `Error: ${message}`, isError: true };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
