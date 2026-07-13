// LSP Protocol types (simplified for diagnostics)

export type DocumentUri = string;

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export enum DiagnosticSeverity {
  Error = 1,
  Warning = 2,
  Information = 3,
  Hint = 4,
}

export enum DiagnosticTag {
  Unnecessary = 1,
  Deprecated = 2,
}

export interface Diagnostic {
  range: Range;
  message: string;
  severity?: DiagnosticSeverity;
  code?: string | number;
  source?: string;
  tags?: DiagnosticTag[];
}

export interface PublishDiagnosticsParams {
  uri: DocumentUri;
  diagnostics: Diagnostic[];
  version?: number;
}

export interface TextDocumentIdentifier {
  uri: DocumentUri;
}

export interface VersionedTextDocumentIdentifier extends TextDocumentIdentifier {
  version: number;
}

export interface TextDocumentItem {
  uri: DocumentUri;
  languageId: string;
  version: number;
  text: string;
}

export interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

export interface TextDocumentContentChangeEvent {
  text: string;
}

export interface DidChangeTextDocumentParams {
  textDocument: VersionedTextDocumentIdentifier;
  contentChanges: TextDocumentContentChangeEvent[];
}

export interface DidCloseTextDocumentParams {
  textDocument: TextDocumentIdentifier;
}

export interface InitializeParams {
  processId: number | null;
  clientInfo?: {
    name: string;
    version?: string;
  };
  rootUri: DocumentUri;
  workspaceFolders?: WorkspaceFolder[];
}

export interface WorkspaceFolder {
  uri: DocumentUri;
  name: string;
}

export interface ServerCapabilities {
  textDocumentSync?: number;
  diagnosticsProvider?: {
    interFileDependencies: boolean;
    workspaceDiagnostics: boolean;
  };
}

export interface InitializeResult {
  capabilities: ServerCapabilities;
}

export interface LSPMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}
