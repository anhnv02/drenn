import type { AgentWindowApi } from '../../shared/ipc';

declare global {
  interface Window {
    api: AgentWindowApi;
  }
}

export {};
