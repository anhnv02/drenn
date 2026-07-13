import { app, BrowserWindow } from 'electron';
import { createMainWindow } from './window';
import { registerIpcHandlers, setMainWindow } from './ipcHandlers';
import { disposeAllTerminals } from './terminal';
import { disposeAllShellJobs } from './tools/backgroundShells';
import { LSPManager } from './lsp/manager';
import { setLSPManager, agentService } from './agent';
import { initPersistedAgents } from './agent/subagent';
import { readMCPServers, readPermissionPatterns } from './config/settingsStore';
import { migrateAll } from './config/migrate';
import { permissionService } from './permission';

process.on('uncaughtException', (err) => {
  console.error('[main] Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] Unhandled rejection:', reason);
});

let lspManager: LSPManager | null = null;

app.whenReady().then(async () => {
  registerIpcHandlers();
  const mainWindow = createMainWindow();
  setMainWindow(mainWindow);

  await migrateAll().catch((err) => {
    console.error('Migration failed:', err);
  });

  await initPersistedAgents().catch((err) => {
    console.error('Failed to load persisted agents:', err);
  });

  const mcpServers = await readMCPServers();
  await agentService.loadMCPToolsFromConfig(mcpServers).catch((err) => {
    console.error('Failed to load MCP tools:', err);
  });

  permissionService.loadPatternRules(readPermissionPatterns());

  const workspaceDir = process.cwd();
  lspManager = new LSPManager(workspaceDir);
  setLSPManager(lspManager);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      setMainWindow(createMainWindow());
    }
  });
});

app.on('window-all-closed', async () => {
  if (lspManager) {
    await lspManager.closeAll().catch((err) => {
      console.error('Error closing LSP servers:', err);
    });
  }
  await agentService.shutdownMCPClients().catch((err) => {
    console.error('Error closing MCP clients:', err);
  });
  disposeAllTerminals();
  disposeAllShellJobs();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
