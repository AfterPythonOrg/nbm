import { json, error } from '@sveltejs/kit';
import { getNotebookPath } from '@nbm/core';
import {
  readRegistry,
  findSession,
  isSessionAlive,
  isNotebookOperationError,
  removeNotebook,
  renameNotebook,
  updateNotebookRuntime,
} from '$lib/server/data';
import type { NotebookDetailResponse } from '$lib/api';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === params.id);
  if (!nb) throw error(404, `Notebook ${params.id} not found`);

  const session = findSession(nb.id);
  const live = session && isSessionAlive(session) ? session : null;

  const body: NotebookDetailResponse = {
    ...nb,
    path: getNotebookPath(nb.id, nb.name, nb.type, nb.workspace),
    session: live,
  };
  return json(body);
};

type PatchBody = { name?: unknown; runtime?: { binary?: unknown; project?: unknown } };

export const PATCH: RequestHandler = async ({ params, request }) => {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === params.id);
  if (!nb) throw error(404, `Notebook ${params.id} not found`);

  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (!body) {
    throw error(400, 'Expected JSON body.');
  }
  const hasName = typeof body.name === 'string';
  const hasRuntime = Boolean(body.runtime);
  if (!hasName && !hasRuntime) {
    throw error(400, 'Expected JSON body with a string name or runtime object.');
  }

  try {
    const notebook = hasName ? await renameNotebook(nb, body.name as string) : updateNotebookRuntime(nb, body.runtime!);
    return json({ ok: true, notebook });
  } catch (e) {
    if (isNotebookOperationError(e)) throw error(e.status, e.message);
    throw error(500, e instanceof Error ? e.message : String(e));
  }
};

// Remove a notebook. Mirrors `nbm remove` (apps/cli/commands/remove.ts):
// stop any live session, delete the notebook directory, then drop the registry
// entry. This stays in-process for the same reason as the stop endpoint: the
// Node primitives map directly to the CLI logic.
export const DELETE: RequestHandler = async ({ params }) => {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === params.id);
  if (!nb) throw error(404, `Notebook ${params.id} not found`);

  try {
    await removeNotebook(nb);
  } catch (e) {
    throw error(500, e instanceof Error ? e.message : String(e));
  }

  return json({ ok: true, removed: true });
};
