import { json, error } from '@sveltejs/kit';
import { isNotebookOperationError, removeWorkspace, renameWorkspace } from '$lib/server/data';
import type { RequestHandler } from './$types';

type PatchBody = { name?: unknown };

export const PATCH: RequestHandler = async ({ params, request }) => {
  const body = (await request.json().catch(() => null)) as PatchBody | null;
  if (!body || typeof body.name !== 'string') {
    throw error(400, 'Expected JSON body with a string name.');
  }

  try {
    return json({ ok: true, ...(await renameWorkspace(params.name, body.name)) });
  } catch (e) {
    if (isNotebookOperationError(e)) throw error(e.status, e.message);
    throw error(500, e instanceof Error ? e.message : String(e));
  }
};

export const DELETE: RequestHandler = async ({ params }) => {
  try {
    return json({ ok: true, removed: true, ...(await removeWorkspace(params.name)) });
  } catch (e) {
    if (isNotebookOperationError(e)) throw error(e.status, e.message);
    throw error(500, e instanceof Error ? e.message : String(e));
  }
};
