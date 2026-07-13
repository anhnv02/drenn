import { join } from 'path';
import { homedir } from 'os';

/** Single root directory for all Drenn config & data. */
export const DRENN_DIR = join(homedir(), '.config', 'drenn');

// Sub-directories / files under DRENN_DIR
export const MCP_CONFIG_FILE = join(DRENN_DIR, 'mcp.json');
export const SETTINGS_FILE = join(DRENN_DIR, 'settings.json');
export const PROVIDERS_FILE = join(DRENN_DIR, 'providers.json');
export const HISTORY_DIR = join(DRENN_DIR, 'history');
export const CHECKPOINT_DIR = join(DRENN_DIR, 'checkpoints');
export const CONTINUATIONS_DIR = join(DRENN_DIR, 'continuations');
export const LOCAL_SESSIONS_DIR = join(DRENN_DIR, 'local');
export const TOOL_OUTPUTS_DIR = join(DRENN_DIR, 'tool-outputs');
export const COMMANDS_DIR = join(DRENN_DIR, 'commands');
export const PERMISSION_RULES_FILE = join(DRENN_DIR, 'permission-rules.json');
export const AGENT_DIR = join(DRENN_DIR, 'agent');
export const MEMORY_DIR = join(DRENN_DIR, 'memory');
