import { Command } from '@cliffy/command';
import { DEFAULT_WORKSPACE_NAME, getNotebookPath } from '@nbm/core';
import { rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveNotebook, deleteNotebook } from '../notebook.ts';
import { findSessionById, removeSession } from '../sessions.ts';
import { isAlive, killProcessGroup, terminateProcessGroup } from '../process.ts';

export const removeCommand = new Command()
  .description('Remove a notebook (stops it, deletes registry entry and files).')
  .arguments('<nameOrId:string>')
  .option('-w, --workspace <name:string>', 'Workspace (when passing a name).', {
    default: DEFAULT_WORKSPACE_NAME,
  })
  .action(async (opts, nameOrId) => {
    const nb = resolveNotebook(nameOrId, opts.workspace);
    if (!nb) {
      console.error(`No notebook found for: ${nameOrId}`);
      Deno.exit(1);
    }

    // Order matters for crash-safety. We delete the registry entry FIRST so
    // that, even if the rest of this action crashes mid-way, the registry is
    // never left pointing at a half-deleted notebook. Worst case after a
    // crash: an orphan session file with a dead PID (cleaned up lazily on
    // next `isAlive` check) and/or orphan files in the workspace dir
    // (harmless; not visible via the registry-driven UI).
    const session = findSessionById(nb.id);
    const sessionAlive = session !== undefined && isAlive(session.pid, session.pidStartTs);

    deleteNotebook(nb.id);

    if (sessionAlive) {
      const ok = await terminateProcessGroup(session.pid, session.pidStartTs);
      if (!ok) {
        console.error(`Failed to stop ${nb.name} (pid ${session.pid})`);
        // Don't bail — the registry entry is already gone, keep cleaning up.
      }
    } else if (session) {
      // Leader is dead but the group may still hold ports (e.g. orphaned LSP
      // children re-parented to launchd). Sweep best-effort.
      killProcessGroup(session.pid, 'SIGTERM');
    }
    if (session) removeSession(nb.id);

    const nbPath = getNotebookPath(nb.id, nb.name, nb.type, nb.workspace);
    rmSync(dirname(nbPath), { recursive: true, force: true });

    console.log(`Removed ${nb.name} (id ${nb.id})`);
  });
