import { createHash } from 'node:crypto';
import { readFileSync, existsSync, rmSync, writeFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join } from 'node:path';
import {
  DEFAULT_MODE,
  EXTENSION_TO_NB_TYPE,
  getConfigPath,
  getHomeDir,
  getNotebookPath,
  getRegistryPath,
  getSessionPath,
  isAlive,
  killProcessGroup,
  terminateProcessGroup,
  findSessionById,
  readRegistry,
} from '@nbm/core';
import type { Mode, Notebook, Registry, Runtime, Session } from '@nbm/core';

export class NotebookOperationError extends Error {
  constructor(
    message: string,
    public status: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function isNotebookOperationError(e: unknown): e is NotebookOperationError {
  return e instanceof NotebookOperationError;
}

// Read-side helpers (registry, sessions, isAlive) live in @nbm/core. Re-export
// here for web callers, with thin name/signature adapters where convenient.
export { readRegistry, listSessions, isAlive, findSessionById } from '@nbm/core';

// Convenience adapters used by +server.ts endpoints.
export const findSession = findSessionById;

const DEFAULT_KEYBINDINGS = {
  nextRunningKeybinding: 'Alt+J',
  previousRunningKeybinding: 'Alt+K',
};

export function isSessionAlive(session: Session): boolean {
  return isAlive(session.pid, session.pidStartTs);
}

// Write-side: mirrors apps/cli/sessions.ts#removeSession. Kept per-runtime to
// match the existing convention (core is read-only).
export function removeSession(notebookId: string): void {
  const path = getSessionPath(notebookId);
  if (existsSync(path)) rmSync(path);
}

function writeRegistry(reg: Registry): void {
  const path = getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, path);
}

export function deleteNotebook(notebookId: string): void {
  const reg = readRegistry();
  reg.notebooks = reg.notebooks.filter((n) => n.id !== notebookId);
  writeRegistry(reg);
}

export async function stopNotebookSession(
  notebookId: string,
): Promise<{ stopped: boolean; reason?: string }> {
  const session = findSessionById(notebookId);
  if (!session) return { stopped: false, reason: 'no-session' };

  if (!isSessionAlive(session)) {
    // The leader is dead, but its process group may still hold ports
    // (orphaned helpers re-parented to launchd). Sweep best-effort.
    killProcessGroup(session.pid, 'SIGTERM');
    removeSession(notebookId);
    return { stopped: false, reason: 'already-dead' };
  }

  // SIGTERM the whole process group, grace period, then SIGKILL the group.
  // Single-PID kill leaks marimo/jupyter LSP children and can leave julia
  // spinning when Pluto's HTTP/WebSocket loops catch the interrupt and never
  // finish shutting down.
  const ok = await terminateProcessGroup(session.pid, session.pidStartTs);
  if (!ok) {
    throw new Error(`Failed to stop pid ${session.pid}`);
  }

  removeSession(notebookId);
  return { stopped: true };
}

export async function removeNotebook(nb: Notebook): Promise<void> {
  await stopNotebookSession(nb.id);
  const nbPath = getNotebookPath(nb.id, nb.name, nb.type, nb.workspace);
  rmSync(dirname(nbPath), { recursive: true, force: true });
  deleteNotebook(nb.id);
}

function generateNotebookId(notebookName: string, notebookType: Notebook['type'], workspaceName: string): string {
  const input = `${workspaceName}/${notebookType}/${notebookName}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

function getWorkspacePath(workspaceName: string): string {
  return join(getHomeDir(), 'workspaces', workspaceName);
}

function normalizeWorkspaceName(rawName: string): string {
  const name = rawName.trim();
  if (!name) throw new NotebookOperationError('Workspace name is required.', 400);
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\')) {
    throw new NotebookOperationError('Workspace name cannot contain path separators.', 400);
  }
  return name;
}

export async function removeWorkspace(rawName: string): Promise<{ removedIds: string[] }> {
  const name = normalizeWorkspaceName(rawName);
  const reg = readRegistry();
  const workspaceExists = reg.workspaces.some((w) => w.name === name);
  const notebooks = reg.notebooks.filter((n) => n.workspace === name);
  if (!workspaceExists && notebooks.length === 0) {
    throw new NotebookOperationError(`Workspace ${name} not found.`, 404);
  }

  for (const nb of notebooks) {
    await stopNotebookSession(nb.id);
  }

  rmSync(getWorkspacePath(name), { recursive: true, force: true });
  reg.notebooks = reg.notebooks.filter((n) => n.workspace !== name);
  reg.workspaces = reg.workspaces.filter((w) => w.name !== name);
  writeRegistry(reg);
  return { removedIds: notebooks.map((n) => n.id) };
}

export async function renameWorkspace(
  rawCurrentName: string,
  rawNextName: string
): Promise<{ workspace: { name: string }; notebooks: Array<{ oldId: string; id: string; name: string }> }> {
  const currentName = normalizeWorkspaceName(rawCurrentName);
  const nextName = normalizeWorkspaceName(rawNextName);
  const reg = readRegistry();
  const workspaceExists = reg.workspaces.some((w) => w.name === currentName);
  const workspaceNotebooks = reg.notebooks.filter((n) => n.workspace === currentName);
  if (!workspaceExists && workspaceNotebooks.length === 0) {
    throw new NotebookOperationError(`Workspace ${currentName} not found.`, 404);
  }
  if (nextName === currentName) {
    return {
      workspace: { name: currentName },
      notebooks: workspaceNotebooks.map((n) => ({ oldId: n.id, id: n.id, name: n.name }))
    };
  }
  if (
    reg.workspaces.some((w) => w.name === nextName) ||
    reg.notebooks.some((n) => n.workspace === nextName)
  ) {
    throw new NotebookOperationError(`Workspace ${nextName} already exists.`, 409);
  }

  const renamedNotebooks = workspaceNotebooks.map((nb) => ({
    ...nb,
    id: generateNotebookId(nb.name, nb.type, nextName),
    workspace: nextName
  }));
  const nextIds = new Set<string>();
  for (const nb of renamedNotebooks) {
    if (
      nextIds.has(nb.id) ||
      reg.notebooks.some((existing) => existing.workspace !== currentName && existing.id === nb.id)
    ) {
      throw new NotebookOperationError(
        `Notebook id collision while renaming workspace ${currentName}.`,
        409
      );
    }
    nextIds.add(nb.id);
  }

  const currentWorkspacePath = getWorkspacePath(currentName);
  const nextWorkspacePath = getWorkspacePath(nextName);
  if (workspaceNotebooks.length > 0 && !existsSync(currentWorkspacePath)) {
    throw new NotebookOperationError(
      `Workspace directory does not exist: ${currentWorkspacePath}`,
      404
    );
  }
  for (const nb of workspaceNotebooks) {
    const currentNotebookDir = dirname(getNotebookPath(nb.id, nb.name, nb.type, currentName));
    if (!existsSync(currentNotebookDir)) {
      throw new NotebookOperationError(
        `Notebook directory does not exist: ${currentNotebookDir}`,
        404
      );
    }
  }
  const currentNotebookDirs = new Set(
    workspaceNotebooks.map((nb) => dirname(getNotebookPath(nb.id, nb.name, nb.type, currentName)))
  );
  for (const [idx, nb] of workspaceNotebooks.entries()) {
    const renamed = renamedNotebooks[idx];
    if (renamed.id === nb.id) continue;
    const currentNotebookDir = dirname(getNotebookPath(nb.id, nb.name, nb.type, currentName));
    const tempNotebookDir = `${currentNotebookDir}.renaming-${renamed.id}`;
    const nextNotebookDir = dirname(
      getNotebookPath(renamed.id, renamed.name, renamed.type, currentName)
    );
    if (existsSync(tempNotebookDir)) {
      throw new NotebookOperationError(
        `Temporary notebook directory already exists: ${tempNotebookDir}`,
        409
      );
    }
    if (existsSync(nextNotebookDir) && !currentNotebookDirs.has(nextNotebookDir)) {
      throw new NotebookOperationError(
        `Notebook directory already exists: ${nextNotebookDir}`,
        409
      );
    }
  }
  if (existsSync(nextWorkspacePath)) {
    throw new NotebookOperationError(
      `Workspace directory already exists: ${nextWorkspacePath}`,
      409
    );
  }

  for (const nb of workspaceNotebooks) {
    await stopNotebookSession(nb.id);
  }

  if (existsSync(currentWorkspacePath)) {
    mkdirSync(dirname(nextWorkspacePath), { recursive: true });
    renameSync(currentWorkspacePath, nextWorkspacePath);
    const idMoves = workspaceNotebooks.flatMap((nb, idx) => {
      const renamed = renamedNotebooks[idx];
      if (renamed.id === nb.id) return [];
      const currentNotebookDir = dirname(getNotebookPath(nb.id, nb.name, nb.type, nextName));
      const nextNotebookDir = dirname(
        getNotebookPath(renamed.id, renamed.name, renamed.type, nextName)
      );
      return [
        {
          currentNotebookDir,
          tempNotebookDir: `${currentNotebookDir}.renaming-${renamed.id}`,
          nextNotebookDir
        }
      ];
    });
    for (const move of idMoves) {
      if (existsSync(move.tempNotebookDir)) {
        throw new NotebookOperationError(
          `Temporary notebook directory already exists: ${move.tempNotebookDir}`,
          409
        );
      }
    }
    for (const move of idMoves) {
      renameSync(move.currentNotebookDir, move.tempNotebookDir);
    }
    for (const move of idMoves) {
      renameSync(move.tempNotebookDir, move.nextNotebookDir);
    }
  }

  const renamedByOldId = new Map(
    workspaceNotebooks.map((nb, idx) => [nb.id, renamedNotebooks[idx]])
  );
  reg.workspaces = reg.workspaces.map((w) =>
    w.name === currentName ? { ...w, name: nextName } : w
  );
  if (!workspaceExists) reg.workspaces.push({ name: nextName });
  reg.notebooks = reg.notebooks.map((n) => renamedByOldId.get(n.id) ?? n);
  writeRegistry(reg);

  return {
    workspace: { name: nextName },
    notebooks: workspaceNotebooks.map((nb, idx) => ({
      oldId: nb.id,
      id: renamedNotebooks[idx].id,
      name: renamedNotebooks[idx].name
    }))
  };
}

export async function renameNotebook(nb: Notebook, rawName: string): Promise<Notebook> {
  const name = rawName.trim();
  if (!name) throw new NotebookOperationError('Notebook name is required.', 400);
  if (name.includes('/') || name.includes('\\')) {
    throw new NotebookOperationError('Notebook name cannot contain path separators.', 400);
  }

  const type = EXTENSION_TO_NB_TYPE[extname(name).toLowerCase()];
  if (!type) throw new NotebookOperationError('Notebook name must end with .py, .jl, or .ipynb.', 400);
  if (type !== nb.type) {
    throw new NotebookOperationError('Changing notebook type during rename is not supported.', 400);
  }
  if (name === nb.name) return nb;

  const nextId = generateNotebookId(name, nb.type, nb.workspace);
  const reg = readRegistry();
  if (reg.notebooks.some((n) => n.id === nextId && n.id !== nb.id)) {
    throw new NotebookOperationError(`A notebook named ${name} already exists in ${nb.workspace}.`, 409);
  }

  await stopNotebookSession(nb.id);

  const oldPath = getNotebookPath(nb.id, nb.name, nb.type, nb.workspace);
  const oldDir = dirname(oldPath);
  const nextPath = getNotebookPath(nextId, name, nb.type, nb.workspace);
  const nextDir = dirname(nextPath);

  if (!existsSync(oldPath)) {
    throw new NotebookOperationError(`Notebook file does not exist: ${oldPath}`, 404);
  }
  if (existsSync(nextDir)) {
    throw new NotebookOperationError(`Notebook directory already exists: ${nextDir}`, 409);
  }

  mkdirSync(dirname(nextDir), { recursive: true });
  renameSync(oldDir, nextDir);
  renameSync(getNotebookPath(nextId, nb.name, nb.type, nb.workspace), nextPath);

  const renamed: Notebook = { ...nb, id: nextId, name };
  reg.notebooks = reg.notebooks.map((n) => (n.id === nb.id ? renamed : n));
  writeRegistry(reg);
  return renamed;
}

function assertExecutablePath(path: string, label: string) {
  if (!path.trim()) throw new NotebookOperationError(`${label} is required.`, 400);
  if (!isAbsolute(path)) throw new NotebookOperationError(`${label} must be an absolute path.`, 400);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new NotebookOperationError(`${label} does not exist: ${path}`, 400);
  }
  if (!stat.isFile()) throw new NotebookOperationError(`${label} must point to a file: ${path}`, 400);
  if ((stat.mode & 0o111) === 0) {
    throw new NotebookOperationError(`${label} is not executable: ${path}`, 400);
  }
}

function normalizeRuntime(nb: Notebook, rawRuntime: { binary?: unknown; project?: unknown }): Runtime {
  if (typeof rawRuntime.binary !== 'string') {
    throw new NotebookOperationError('Runtime binary must be a string.', 400);
  }
  const binary = rawRuntime.binary.trim();
  assertExecutablePath(binary, 'Runtime binary');

  if (rawRuntime.project !== undefined && rawRuntime.project !== null && typeof rawRuntime.project !== 'string') {
    throw new NotebookOperationError('Runtime project must be a string.', 400);
  }
  const project = typeof rawRuntime.project === 'string' ? rawRuntime.project.trim() : '';
  if (project) {
    if (nb.type !== 'pluto') throw new NotebookOperationError('Runtime project is only supported for Pluto notebooks.', 400);
    if (!isAbsolute(project)) throw new NotebookOperationError('Runtime project must be an absolute path.', 400);
    if (!existsSync(project)) throw new NotebookOperationError(`Runtime project does not exist: ${project}`, 400);
  }

  return project ? { binary, project } : { binary };
}

export function updateNotebookRuntime(nb: Notebook, rawRuntime: { binary?: unknown; project?: unknown }): Notebook {
  const session = findSessionById(nb.id);
  if (session && isSessionAlive(session)) {
    throw new NotebookOperationError('Stop the notebook before changing its runtime.', 409);
  }
  if (session) removeSession(nb.id);

  const runtime = normalizeRuntime(nb, rawRuntime);
  const updated: Notebook = { ...nb, runtime };
  const reg = readRegistry();
  reg.notebooks = reg.notebooks.map((n) => (n.id === nb.id ? updated : n));
  writeRegistry(reg);
  return updated;
}

// Mirrors apps/cli/config.ts#readConfig for the `mode` field. The default
// (DEFAULT_MODE) is shared via @nbm/core so the CLI and the web server can
// never disagree about what an absent/invalid value means.
export function readMode(): Mode {
  const path = getConfigPath();
  if (!existsSync(path)) return DEFAULT_MODE;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as { mode?: Mode };
    if (cfg.mode === 'embedded' || cfg.mode === 'standalone') return cfg.mode;
    return DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

export function readKeybindings(): typeof DEFAULT_KEYBINDINGS {
  const path = getConfigPath();
  if (!existsSync(path)) return DEFAULT_KEYBINDINGS;
  try {
    const cfg = JSON.parse(readFileSync(path, 'utf8')) as Partial<typeof DEFAULT_KEYBINDINGS>;
    return {
      nextRunningKeybinding:
        typeof cfg.nextRunningKeybinding === 'string'
          ? cfg.nextRunningKeybinding
          : DEFAULT_KEYBINDINGS.nextRunningKeybinding,
      previousRunningKeybinding:
        typeof cfg.previousRunningKeybinding === 'string'
          ? cfg.previousRunningKeybinding
          : DEFAULT_KEYBINDINGS.previousRunningKeybinding,
    };
  } catch {
    return DEFAULT_KEYBINDINGS;
  }
}
