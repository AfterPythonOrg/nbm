import { writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import type { Session } from '@nbm/core';
import { getSessionPath, getSessionsDir } from '@nbm/core';

// Re-export read-side helpers from core so callers can keep importing from this module.
export { findSessionById, listSessions } from '@nbm/core';

export function upsertSession(session: Session): void {
  mkdirSync(getSessionsDir(), { recursive: true });
  const path = getSessionPath(session.notebookId);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(session, null, 2));
  renameSync(tmp, path);
}

export function removeSession(notebookId: string): void {
  const path = getSessionPath(notebookId);
  if (existsSync(path)) rmSync(path);
}
