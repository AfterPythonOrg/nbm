import { writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { getRegistryPath, type Registry } from '@nbm/core';

// Re-export read-side helper from core so callers can keep importing from this module.
export { readRegistry } from '@nbm/core';

export function writeRegistry(reg: Registry): void {
  const path = getRegistryPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, path);
}
