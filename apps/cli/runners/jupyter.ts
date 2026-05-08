import { basename } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { Runtime, SpawnResult } from '@nbm/core';
import { spawnAndTrack } from '../process.ts';
import { upsertSession } from '../sessions.ts';
import { findSessionById } from '@nbm/core';

const EMPTY_IPYNB = JSON.stringify(
  { cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 },
  null,
  2,
);

export async function spawnJupyter(
  nbID: string,
  nbPath: string,
  runtime: Runtime,
  isEmbedded: boolean,
  extraArgs: string[] = [],
): Promise<SpawnResult> {
  // --no-browser: nbm owns browser opening after capturing the URL in
  //   standalone mode, and embedded mode renders through the already-running
  //   nbm UI. Without this we'd get a duplicate tab in standalone and a stray
  //   system tab in embedded.
  // --ServerApp.tornado_settings (embedded only): Jupyter defaults to a CSP
  //   of `frame-ancestors 'self'`, which blocks iframing from the nbm UI
  //   origin (localhost:5173). Override to allow that origin. Same key works
  //   on modern jupyter-server; older notebook reads NotebookApp, so set both.
  // Jupyter errors out if the file is missing — unlike marimo, it won't
  // create one. Write an empty notebook stub so first-launch works.
  if (!existsSync(nbPath)) {
    writeFileSync(nbPath, EMPTY_IPYNB);
  }

  const cspArgs = isEmbedded
    ? [
        `--ServerApp.tornado_settings={"headers":{"Content-Security-Policy":"frame-ancestors 'self' http://localhost:* http://127.0.0.1:*"}}`,
        `--NotebookApp.tornado_settings={"headers":{"Content-Security-Policy":"frame-ancestors 'self' http://localhost:* http://127.0.0.1:*"}}`,
      ]
    : [];

  const result = await spawnAndTrack(
    nbID,
    runtime.binary,
    ['-m', 'jupyter', 'notebook', '--no-browser', ...cspArgs, nbPath, ...extraArgs],
  );

  // Jupyter prints its server-root URL (e.g. .../tree?token=...) — that's the
  // file browser, not the notebook itself. Rewrite to /notebooks/<file> so the
  // iframe deeplinks straight to the notebook view. Persist the corrected URL
  // in the session record so the UI sees it on subsequent reads.
  const u = new URL(result.url);
  u.pathname = `/notebooks/${basename(nbPath)}`;
  const fixedUrl = u.toString();

  const session = findSessionById(nbID);
  if (session) {
    upsertSession({ ...session, url: fixedUrl });
  }

  return { ...result, url: fixedUrl };
}
