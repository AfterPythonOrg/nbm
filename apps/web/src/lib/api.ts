import type { Mode, Notebook, NotebookType, Session } from '@nbm/core';

export type WorkspaceItemDTO = { id: string; name: string; running: boolean };
export type WorkspaceGroupDTO = { name: string; notebooks: WorkspaceItemDTO[] };
export type RunningItemDTO = { id: string; name: string };
export type KeybindingsDTO = { nextRunningKeybinding: string; previousRunningKeybinding: string };

export type NotebooksResponse = {
  mode: Mode;
  keybindings: KeybindingsDTO;
  workspaces: WorkspaceGroupDTO[];
  running: RunningItemDTO[];
};

export type NotebookDetailResponse = Notebook & {
  path: string;
  session: Session | null;
};

export type NotebookPreviewCell = {
  id: string;
  kind: 'code' | 'markdown' | 'raw';
  language: 'python' | 'julia' | 'sql' | 'markdown' | 'text';
  source: string;
  html: string;
};

export type NotebookPreviewResponse = {
  notebook: { id: string; name: string; type: NotebookType; path: string };
  cells: NotebookPreviewCell[];
  warnings: string[];
};
