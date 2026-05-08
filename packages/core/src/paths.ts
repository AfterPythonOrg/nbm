import os from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE_NAME } from "./const.ts";
import type { NotebookType } from "./types.ts";

function getHomeDir(): string {
  return join(os.homedir(), '.nbm');
}

function getRegistryPath(): string {
  return join(getHomeDir(), 'registry.json');
}

function getConfigPath(): string {
  return join(getHomeDir(), 'config.json');
}

function getNotebookPath(
  notebookId: string,
  notebookName: string,
  notebookType: NotebookType,
  workspaceName: string = DEFAULT_WORKSPACE_NAME,
): string {
  return join(
    getHomeDir(),
    'workspaces',
    workspaceName,
    notebookType,
    notebookId,
    notebookName,
  );
}

function getSessionsDir(): string {
  return join(getHomeDir(), 'sessions');
}

function getSessionPath(notebookId: string): string {
  return join(getSessionsDir(), `${notebookId}.json`);
}

function getSessionLogPath(notebookId: string): string {
  return join(getSessionsDir(), `${notebookId}.log`);
}

export {
  getHomeDir,
  getRegistryPath,
  getConfigPath,
  getNotebookPath,
  getSessionsDir,
  getSessionPath,
  getSessionLogPath,
};