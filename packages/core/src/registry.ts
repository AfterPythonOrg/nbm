import { readFileSync, existsSync } from 'node:fs';
import { getRegistryPath } from './paths.ts';
import { DEFAULT_WORKSPACE_NAME, REGISTRY_VERSION } from './const.ts';
import type { Registry } from './types.ts';

const EMPTY_REGISTRY: Registry = {
  version: REGISTRY_VERSION,
  workspaces: [{ name: DEFAULT_WORKSPACE_NAME }],
  notebooks: [],
};

export function readRegistry(): Registry {
  const path = getRegistryPath();
  if (!existsSync(path)) return structuredClone(EMPTY_REGISTRY);
  return JSON.parse(readFileSync(path, 'utf8')) as Registry;
}
