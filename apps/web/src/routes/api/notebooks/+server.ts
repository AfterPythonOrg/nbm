import { json } from '@sveltejs/kit';
import { readRegistry, listSessions, isSessionAlive, readMode, readKeybindings } from '$lib/server/data';
import type { NotebooksResponse } from '$lib/api';

export function GET() {
  const reg = readRegistry();
  const liveSessions = listSessions().filter(isSessionAlive);
  const liveIds = new Set(liveSessions.map((s) => s.notebookId));
  const notebookById = new Map(reg.notebooks.map((n) => [n.id, n]));

  const workspaces = reg.workspaces.map((ws) => ({
    name: ws.name,
    notebooks: reg.notebooks
      .filter((n) => n.workspace === ws.name)
      .map((n) => ({ id: n.id, name: n.name, running: liveIds.has(n.id) })),
  }));

  // Sort by startedAt desc so the UI can pick `running[0]` as the most
  // recently started notebook (used to auto-focus on initial load).
  const running = liveSessions
    .slice()
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .map((s) => notebookById.get(s.notebookId))
    .filter((n): n is NonNullable<typeof n> => Boolean(n))
    .map((n) => ({ id: n.id, name: n.name }));

  const body: NotebooksResponse = { mode: readMode(), keybindings: readKeybindings(), workspaces, running };
  return json(body);
}
