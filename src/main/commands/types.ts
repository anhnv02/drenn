export interface CustomCommand {
  id: string;
  title: string;
  description: string;
  content: string;
  args?: CommandArg[];
}

export interface CommandArg {
  name: string;
  value?: string;
}

export interface CommandRunResult {
  content: string;
  args?: Record<string, string>;
}
