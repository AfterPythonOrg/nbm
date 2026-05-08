import { error, json } from '@sveltejs/kit';
import { readRegistry } from '$lib/server/data';
import { buildNotebookPreview } from '$lib/server/notebook-preview';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ params }) => {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === params.id);
  if (!nb) throw error(404, `Notebook ${params.id} not found`);

  try {
    return json(await buildNotebookPreview(nb), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    throw error(500, e instanceof Error ? e.message : String(e));
  }
};
