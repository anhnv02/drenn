import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import { parseToolInput } from '../../shared/utils/json';

interface SourcegraphParams {
  query: string;
  count?: number;
  context_window?: number;
  timeout?: number;
}

const SOURCEGRAPH_DESCRIPTION = `Search code across public repositories using Sourcegraph's GraphQL API.

WHEN TO USE THIS TOOL:
- Use when you need to find code examples or implementations across public repositories
- Helpful for researching how others have solved similar problems
- Useful for discovering patterns and best practices in open source code

HOW TO USE:
- Provide a search query using Sourcegraph's query syntax
- Optionally specify the number of results to return (default: 10, max: 20)
- Optionally set a timeout for the request

QUERY SYNTAX:
- Basic search: "fmt.Println" searches for exact matches
- File filters: "file:.go fmt.Println" limits to Go files
- Repository filters: "repo:^github\\.com/golang/go$ fmt.Println" limits to specific repos
- Language filters: "lang:go fmt.Println" limits to Go code
- Boolean operators: "fmt.Println AND log.Fatal" for combined terms
- Regular expressions: "fmt\\.(Print|Printf|Println)" for pattern matching
- Quoted strings: "\\"exact phrase\\"" for exact phrase matching

EXAMPLES:
- "file:.go context.WithTimeout" - Find Go code using context.WithTimeout
- "lang:typescript useState type:symbol" - Find TypeScript React useState hooks
- "repo:^github\\.com/kubernetes/kubernetes$ pod list" - Find Kubernetes files

LIMITATIONS:
- Only searches public repositories
- Rate limits may apply
- Maximum of 20 results per query`;

export class SourcegraphTool implements BaseTool {
  private baseUrl = 'https://sourcegraph.com/.api/graphql';

  info(): ToolInfo {
    return {
      name: 'sourcegraph',
      description: SOURCEGRAPH_DESCRIPTION,
      parameters: {
        query: {
          type: 'string',
          description: 'The Sourcegraph search query',
        },
        count: {
          type: 'number',
          description: 'Optional number of results to return (default: 10, max: 20)',
        },
        context_window: {
          type: 'number',
          description: 'The context around the match to return (default: 10 lines)',
        },
        timeout: {
          type: 'number',
          description: 'Optional timeout in seconds (max 120)',
        },
      },
      required: ['query'],
    };
  }

  async run(_ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const params = parseToolInput<SourcegraphParams>(call.input);

    if (!params.query) {
      return { content: 'Query parameter is required', isError: true };
    }

    const count = Math.min(Math.max(params.count || 10, 1), 20);
    const contextWindow = params.context_window || 10;
    const timeout = Math.min(params.timeout || 30, 120);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout * 1000);

    try {
      const request = {
        query: `query Search($query: String!) { search(query: $query, version: V2, patternType: keyword) { results { matchCount, limitHit, resultCount, results { __typename, ... on FileMatch { repository { name }, file { path, url, content }, lineMatches { preview, lineNumber, offsetAndLengths } } } } } }`,
        variables: { query: params.query },
      };

      const resp = await fetch(this.baseUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'drenn/0.0.1',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const body = await resp.text();
        return {
          content: `Request failed with status code: ${resp.status}${body ? ', response: ' + body : ''}`,
          isError: true,
        };
      }

      const result = await resp.json();
      const formatted = this.formatResults(result, contextWindow);
      return { content: formatted, isError: false };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { content: 'Request timed out', isError: true };
      }
      return {
        content: error instanceof Error ? error.message : String(error),
        isError: true,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private formatResults(result: any, contextWindow: number): string {
    const lines: string[] = [];

    if (result.errors && result.errors.length > 0) {
      lines.push('## Sourcegraph API Error\n');
      for (const err of result.errors) {
        if (err.message) {
          lines.push(`- ${err.message}`);
        }
      }
      return lines.join('\n');
    }

    const search = result.data?.search?.results;
    if (!search) {
      return 'Invalid response format';
    }

    const matchCount = search.matchCount || 0;
    const resultCount = search.resultCount || 0;
    const limitHit = search.limitHit;

    lines.push('# Sourcegraph Search Results\n');
    lines.push(`Found ${matchCount} matches across ${resultCount} results`);

    if (limitHit) {
      lines.push('(Result limit reached, try a more specific query)');
    }

    lines.push('');

    const results = search.results || [];
    if (results.length === 0) {
      lines.push('No results found. Try a different query.');
      return lines.join('\n');
    }

    const maxResults = Math.min(results.length, 10);

    for (let i = 0; i < maxResults; i++) {
      const fileMatch = results[i];
      if (fileMatch.__typename !== 'FileMatch') continue;

      const repoName = fileMatch.repository?.name;
      const filePath = fileMatch.file?.path;
      const fileURL = fileMatch.file?.url;
      const fileContent = fileMatch.file?.content;
      const lineMatches = fileMatch.lineMatches || [];

      lines.push(`## Result ${i + 1}: ${repoName}/${filePath}\n`);

      if (fileURL) {
        lines.push(`URL: ${fileURL}\n`);
      }

      for (const lm of lineMatches) {
        const lineNumber = lm.lineNumber;
        const preview = lm.preview;

        if (fileContent) {
          const contentLines = fileContent.split('\n');
          lines.push('```');

          const startLine = Math.max(1, lineNumber - contextWindow);
          for (let j = startLine - 1; j < lineNumber - 1 && j < contentLines.length; j++) {
            if (j >= 0) {
              lines.push(`${j + 1}| ${contentLines[j]}`);
            }
          }

          lines.push(`${lineNumber}|  ${preview}`);

          const endLine = lineNumber + contextWindow;
          for (let j = lineNumber; j < endLine && j < contentLines.length; j++) {
            lines.push(`${j + 1}| ${contentLines[j]}`);
          }

          lines.push('```\n');
        } else {
          lines.push('```');
          lines.push(`${lineNumber}| ${preview}`);
          lines.push('```\n');
        }
      }
    }

    return lines.join('\n');
  }
}
