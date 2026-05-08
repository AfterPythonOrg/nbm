import type { NotebookType, Runtime, SpawnResult } from '@nbm/core';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnMarimo } from './marimo.ts';
import { spawnPluto } from './pluto.ts';
import { spawnJupyter } from './jupyter.ts';

export function runNotebook(
  nbID: string,
  nbType: NotebookType,
  nbPath: string,
  runtime: Runtime,
  isEmbedded: boolean,
  extraArgs: string[] = [],
): Promise<SpawnResult> {
  mkdirSync(dirname(nbPath), { recursive: true });
  switch (nbType) {
    case 'marimo':
      return spawnMarimo(nbID, nbPath, runtime, isEmbedded, extraArgs);
    case 'jupyter':
      return spawnJupyter(nbID, nbPath, runtime, isEmbedded, extraArgs);
    case 'pluto':
      return spawnPluto(nbID, nbPath, runtime, isEmbedded, extraArgs);
  }
}
