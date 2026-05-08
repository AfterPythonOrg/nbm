import { readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getSessionPath, getSessionsDir } from './paths.ts';
import { readRegistry } from './registry.ts';
import { isAlive } from './process.ts';
import type { Session } from './types.ts';

export function findSessionById(notebookId: string): Session | undefined {
  const path = getSessionPath(notebookId);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as Session;
}

export function listSessions(): Session[] {
  const dir = getSessionsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Session);
}

/**
 * Remove session files whose process is dead OR whose notebook is no longer
 * in the registry. Returns the IDs that were pruned.
 *
 * Safe to call any time. Does not touch live sessions or registry entries.
 * Intended for `nbm doctor` / opportunistic sweeps; not auto-invoked on every
 * read because that would mix read and write concerns.
 */
export function pruneOrphanSessions(): string[] {
  const sessions = listSessions();
  if (sessions.length === 0) return [];

  const registryIds = new Set(readRegistry().notebooks.map((n) => n.id));
  const removed: string[] = [];

  for (const s of sessions) {
    const orphaned = !registryIds.has(s.notebookId);
    const dead = !isAlive(s.pid, s.pidStartTs);
    if (orphaned || dead) {
      const path = getSessionPath(s.notebookId);
      if (existsSync(path)) {
        rmSync(path);
        removed.push(s.notebookId);
      }
    }
  }
  return removed;
}
