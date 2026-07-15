import type { BaseTool, ExecutionContext, ToolCall, ToolInfo, ToolResponse } from './types';
import type { LSPClient } from '../lsp/client';
import type { Diagnostic } from '../lsp/protocol';
import { DiagnosticSeverity } from '../lsp/protocol';
import { parseToolInput } from '../../shared/utils/json';

interface DiagnosticsParams {
  file_path?: string;
}

export class DiagnosticsTool implements BaseTool {
  private lspClients: Map<string, LSPClient>;

  constructor(lspClients: Map<string, LSPClient>) {
    this.lspClients = lspClients;
  }

  info(): ToolInfo {
    return {
      name: 'diagnostics',
      description: `Get diagnostics for a file and/or project.
WHEN TO USE THIS TOOL:
- Use when you need to check for errors or warnings in your code
- Helpful for debugging and ensuring code quality
- Good for getting a quick overview of issues in a file or project
HOW TO USE:
- Provide a path to a file to get diagnostics for that file
- Leave the path empty to get diagnostics for the entire project
FEATURES:
- Displays errors, warnings, and hints
- Groups diagnostics by severity
- Provides detailed information about each diagnostic`,
      parameters: {
        file_path: {
          type: 'string',
          description:
            'The path to the file to get diagnostics for (leave empty for project diagnostics)',
        },
      },
      required: [],
    };
  }

  async run(_ctx: ExecutionContext, call: ToolCall): Promise<ToolResponse> {
    const params = parseToolInput<DiagnosticsParams>(call.input);

    if (this.lspClients.size === 0) {
      return { content: 'No LSP clients available', isError: true };
    }

    if (params.file_path) {
      await this.waitForDiagnostics(params.file_path);
    }

    const output = this.getDiagnostics(params.file_path);
    return { content: output, isError: false };
  }

  private async waitForDiagnostics(filePath: string): Promise<void> {
    for (const client of this.lspClients.values()) {
      try {
        if (!client['openFiles'].has(`file://${filePath}`)) {
          const content = require('fs').readFileSync(filePath, 'utf-8');
          await client.openFile(filePath, content);
        }
        await client.waitForDiagnostics(filePath, 2000);
      } catch (err) {
        console.error('LSP error:', err);
      }
    }
  }

  private getDiagnostics(filePath?: string): string {
    const fileDiagnostics: string[] = [];
    const projectDiagnostics: string[] = [];

    const formatDiagnostic = (path: string, diagnostic: Diagnostic, source: string): string => {
      let severity = 'Info';
      switch (diagnostic.severity) {
        case DiagnosticSeverity.Error:
          severity = 'Error';
          break;
        case DiagnosticSeverity.Warning:
          severity = 'Warn';
          break;
        case DiagnosticSeverity.Hint:
          severity = 'Hint';
          break;
      }

      const location = `${path}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}`;
      const sourceInfo = diagnostic.source || source;
      const codeInfo = diagnostic.code ? `[${diagnostic.code}]` : '';

      return `${severity}: ${location} [${sourceInfo}]${codeInfo} ${diagnostic.message}`;
    };

    for (const [name, client] of this.lspClients.entries()) {
      const diagnostics = client.getDiagnostics() as Map<string, Diagnostic[]>;
      for (const [uri, diags] of diagnostics) {
        const path = uri.replace('file://', '');
        const isCurrentFile = filePath && path === filePath;

        for (const diag of diags) {
          const formatted = formatDiagnostic(path, diag, name);
          if (isCurrentFile) {
            fileDiagnostics.push(formatted);
          } else {
            projectDiagnostics.push(formatted);
          }
        }
      }
    }

    const output: string[] = [];

    if (fileDiagnostics.length > 0) {
      output.push('\n<file_diagnostics>');
      if (fileDiagnostics.length > 10) {
        output.push(...fileDiagnostics.slice(0, 10));
        output.push(`... and ${fileDiagnostics.length - 10} more diagnostics`);
      } else {
        output.push(...fileDiagnostics);
      }
      output.push('</file_diagnostics>');
    }

    if (projectDiagnostics.length > 0) {
      output.push('\n<project_diagnostics>');
      if (projectDiagnostics.length > 10) {
        output.push(...projectDiagnostics.slice(0, 10));
        output.push(`... and ${projectDiagnostics.length - 10} more diagnostics`);
      } else {
        output.push(...projectDiagnostics);
      }
      output.push('</project_diagnostics>');
    }

    if (fileDiagnostics.length > 0 || projectDiagnostics.length > 0) {
      const fileErrors = fileDiagnostics.filter((d) => d.startsWith('Error')).length;
      const fileWarnings = fileDiagnostics.filter((d) => d.startsWith('Warn')).length;
      const projectErrors = projectDiagnostics.filter((d) => d.startsWith('Error')).length;
      const projectWarnings = projectDiagnostics.filter((d) => d.startsWith('Warn')).length;

      output.push('\n<diagnostic_summary>');
      output.push(`Current file: ${fileErrors} errors, ${fileWarnings} warnings`);
      output.push(`Project: ${projectErrors} errors, ${projectWarnings} warnings`);
      output.push('</diagnostic_summary>');
    }

    return output.join('\n');
  }
}
