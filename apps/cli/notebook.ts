import { createHash } from 'node:crypto';
import { extname } from 'node:path';
import { EXTENSION_TO_NB_TYPE } from '@nbm/core';
import type { NotebookType, Notebook, Runtime } from '@nbm/core';
import { readRegistry, writeRegistry } from './registry.ts';

export function detectNotebookType(name: string): NotebookType | null {
  return EXTENSION_TO_NB_TYPE[extname(name).toLowerCase()] || null;
}

export function generateNotebookId(
  notebookName: string,
  notebookType: NotebookType,
  workspaceName: string,
): string {
  const input = `${workspaceName}/${notebookType}/${notebookName}`;
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

export function findNotebookById(id: string): Notebook | undefined {
  return readRegistry().notebooks.find((n) => n.id === id);
}

export function createNotebook(nb: Notebook): void {
  const reg = readRegistry();
  if (!reg.workspaces.some((w) => w.name === nb.workspace)) {
    reg.workspaces.push({ name: nb.workspace });
  }
  reg.notebooks.push(nb);
  writeRegistry(reg);
}

export function deleteNotebook(id: string): void {
  const reg = readRegistry();
  reg.notebooks = reg.notebooks.filter((n) => n.id !== id);
  writeRegistry(reg);
}

export function updateNotebookRuntime(id: string, runtime: Runtime): Notebook | undefined {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === id);
  if (!nb) return undefined;
  const updated = { ...nb, runtime };
  reg.notebooks = reg.notebooks.map((n) => (n.id === id ? updated : n));
  writeRegistry(reg);
  return updated;
}

export function listNotebooks(): Notebook[] {
  return readRegistry().notebooks;
}

export function resolveNotebook(nameOrId: string, workspace: string): Notebook | undefined {
  // Try as ID first (deterministic 8-hex-char form).
  const byId = findNotebookById(nameOrId);
  if (byId) return byId;

  // Else treat as a notebook name and resolve via workspace + extension.
  const nbType = detectNotebookType(nameOrId);
  if (!nbType) return undefined;

  const id = generateNotebookId(nameOrId, nbType, workspace);
  return findNotebookById(id);
}
