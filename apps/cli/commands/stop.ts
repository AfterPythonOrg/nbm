import { Command } from '@cliffy/command';
import { DEFAULT_WORKSPACE_NAME } from '@nbm/core';
import type { Session } from '@nbm/core';
import { findNotebookById, resolveNotebook } from '../notebook.ts';
import { findSessionById, listSessions, removeSession } from '../sessions.ts';
import { isAlive, killProcessGroup, terminateProcessGroup } from '../process.ts';
import { clearUiState, readUiState } from '../ui.ts';

type StopOutcome = 'stopped' | 'cleaned' | 'failed';

async function stopSession(session: Session, label: string): Promise<StopOutcome> {
  // Even if the leader is dead, sweep its process group: marimo/jupyter/pluto
  // helper children (LSP, copilot, etc.) may still be holding ports. They
  // share the leader's pgid, so a group-kill catches them.
  if (!isAlive(session.pid, session.pidStartTs)) {
    killProcessGroup(session.pid, 'SIGTERM');
    removeSession(session.notebookId);
    console.log(`Session for ${label} was already dead — cleaned up (and swept group ${session.pid})`);
    return 'cleaned';
  }
  const ok = await terminateProcessGroup(session.pid, session.pidStartTs);
  if (!ok) {
    console.error(`Failed to stop ${label} (pid ${session.pid})`);
    return 'failed';
  }
  removeSession(session.notebookId);
  console.log(`Stopped ${label} (pid ${session.pid})`);
  return 'stopped';
}

const allCommand = new Command()
  .description('Stop all active notebook sessions.')
  .action(async () => {
    const sessions = listSessions();
    if (sessions.length === 0) {
      console.log('No active sessions');
      return;
    }

    let failed = 0;
    for (const session of sessions) {
      const label = findNotebookById(session.notebookId)?.name ?? session.notebookId;
      if ((await stopSession(session, label)) === 'failed') failed++;
    }

    if (failed > 0) Deno.exit(1);
  });

const uiCommand = new Command()
  .description('Stop the nbm web UI.')
  .action(async () => {
    const state = readUiState();
    if (!state) {
      console.log('nbm UI is not running');
      return;
    }
    if (!isAlive(state.pid, state.pidStartTs)) {
      killProcessGroup(state.pid, 'SIGTERM');
      clearUiState();
      console.log('nbm UI was already dead — cleaned up');
      return;
    }
    const ok = await terminateProcessGroup(state.pid, state.pidStartTs);
    if (!ok) {
      console.error(`Failed to stop nbm UI (pid ${state.pid})`);
      Deno.exit(1);
    }
    clearUiState();
    console.log(`Stopped nbm UI (pid ${state.pid})`);
  });

export const stopCommand = new Command()
  .description('Stop a running notebook session. Use "nbm stop all" to stop every active session, or "nbm stop ui" to stop the embedded web UI.')
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

    const session = findSessionById(nb.id);
    if (!session) {
      console.log(`No active session for ${nb.name}`);
      Deno.exit(0);
    }

    const outcome = await stopSession(session, nb.name);
    if (outcome === 'failed') Deno.exit(1);
  })
  .command('all', allCommand)
  .command('ui', uiCommand);
