import type { Runtime } from '@nbm/core';
import { spawnAndTrack } from '../process.ts';

export function spawnMarimo(
  nbID: string,
  nbPath: string,
  runtime: Runtime,
  _isEmbedded: boolean,
  extraArgs: string[] = [],
) {
  // --headless suppresses marimo's auto browser open; nbm owns browser opening
  // after capturing the URL in standalone mode, and embedded mode renders
  // through the already-running nbm UI. Without this we'd get a duplicate tab
  // in standalone and a stray system tab in embedded.
  return spawnAndTrack(
    nbID,
    runtime.binary,
    ['-m', 'marimo', 'edit', '--headless', nbPath, ...extraArgs],
  );
}
