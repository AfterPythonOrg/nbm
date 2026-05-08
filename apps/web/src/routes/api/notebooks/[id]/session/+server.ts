import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { json, error } from '@sveltejs/kit';
import {
  readRegistry,
  findSession,
  isSessionAlive,
  stopNotebookSession,
} from '$lib/server/data';
import type { RequestHandler } from './$types';

const execFileP = promisify(execFile);
const START_TIMEOUT_MS = 90_000;

// Stop a running notebook session. Mirrors `nbm stop` (apps/cli/commands/stop.ts):
// SIGTERM the whole process group, brief grace, SIGKILL fallback. We don't shell
// out to the CLI because the web server runs Node and the kill primitives are
// identical.
export const DELETE: RequestHandler = async ({ params }) => {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === params.id);
  if (!nb) throw error(404, `Notebook ${params.id} not found`);

  try {
    const result = await stopNotebookSession(nb.id);
    return json({ ok: true, ...result });
  } catch (e) {
    throw error(500, e instanceof Error ? e.message : String(e));
  }
};

// Start a notebook session. Unlike DELETE, we shell out to `nbm start`: the
// start path does runtime detection, per-type spawning, log/URL polling, and
// session JSON writing — all of which are CLI-side and would be costly to port.
// `nbm` is on PATH by construction (the web is launched by `nbm ui`).
// `--no-open` keeps the CLI from opening a system browser tab on top of the
// already-open UI.
export const POST: RequestHandler = async ({ params }) => {
  const reg = readRegistry();
  const nb = reg.notebooks.find((n) => n.id === params.id);
  if (!nb) throw error(404, `Notebook ${params.id} not found`);

  const existing = findSession(nb.id);
  if (existing && isSessionAlive(existing)) {
    return json({ ok: true, started: false, reason: 'already-running', session: existing });
  }

  try {
    await execFileP('nbm', ['start', nb.name, '-w', nb.workspace, '--no-open'], {
      timeout: START_TIMEOUT_MS,
    });
  } catch (e) {
    const err = e as { stderr?: string; message?: string; code?: number; killed?: boolean };
    const detail = err.stderr?.trim() || err.message || `nbm start exited with code ${err.code}`;
    throw error(500, `Failed to start ${nb.name}: ${detail}`);
  }

  const session = findSession(nb.id);
  if (!session) throw error(500, `nbm start succeeded but no session was recorded for ${nb.name}.`);
  return json({ ok: true, started: true, session });
};
