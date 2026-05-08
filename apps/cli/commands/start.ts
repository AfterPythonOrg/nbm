import { Command } from '@cliffy/command';
import { DEFAULT_WORKSPACE_NAME, getNotebookPath } from '@nbm/core';
import type { Notebook } from '@nbm/core';
import { runNotebook } from '../runners/index.ts';
import { captureRuntime } from '../runtime.ts';
import { generateNotebookId, findNotebookById, createNotebook, deleteNotebook, detectNotebookType } from '../notebook.ts';
import { findSessionById, removeSession } from '../sessions.ts';
import { isAlive, killProcessGroup } from '../process.ts';
import { readConfig } from '../config.ts';
import { clearUiState, readUiState } from '../ui.ts';
import { openInBrowser } from '../browser.ts';

export const startCommand = new Command()
  .description('Start a notebook session.')
  .arguments('<nbName:string>')
  .option('-w, --workspace <name:string>', 'Workspace to start the notebook in.', {
    default: DEFAULT_WORKSPACE_NAME,
  })
  .option('--no-open', 'Do not auto-open the browser (standalone mode only).')
  .action(async (opts, nbName) => {
    const dashIdx = Deno.args.indexOf('--');
    const extraArgs = dashIdx >= 0 ? Deno.args.slice(dashIdx + 1) : [];
    const nbType = detectNotebookType(nbName);
    if (!nbType) {
      console.error(`Unknown notebook type for: ${nbName}`);
      Deno.exit(1);
    }

    const nbID = generateNotebookId(nbName, nbType, opts.workspace);
    const nbPath = getNotebookPath(nbID, nbName, nbType, opts.workspace);
    const config = readConfig();
    const isEmbedded = config.mode === 'embedded';

    if (isEmbedded) {
      requireUiAlreadyRunning();
    }

    let nb: Notebook | undefined = findNotebookById(nbID);
    let url: string;
    let pid: number;
    let createdNew = false;

    if (nb) {
      const session = findSessionById(nbID);
      if (session && isAlive(session.pid, session.pidStartTs)) {
        console.log(`Already running at ${session.url}`);
        url = session.url;
        pid = session.pid;
      } else {
        if (session) {
          // The leader is dead, but its process group may still hold ports
          // (orphaned LSP/copilot/etc. children re-parented to launchd).
          // Sweep before spawning a fresh session so we don't pile up.
          killProcessGroup(session.pid, 'SIGTERM');
          removeSession(nbID);
          console.log(`Cleaned up dead session for ${nb.name}`);
        }
        console.log(`Loading existing notebook (runtime: ${nb.runtime.binary})`);
        try {
          ({ pid, url } = await spawn(nbPath, nb, extraArgs, isEmbedded));
        } catch (e) {
          failStart(e, nbName);
        }
      }
    } else {
      const runtime = captureRuntime(nbType);
      nb = {
        id: nbID,
        name: nbName,
        type: nbType,
        workspace: opts.workspace,
        runtime,
        createdAt: new Date().toISOString(),
      };
      createNotebook(nb);
      createdNew = true;
      console.log(`Created new notebook (runtime: ${nb.runtime.binary})`);
      try {
        ({ pid, url } = await spawn(nbPath, nb, extraArgs, isEmbedded));
      } catch (e) {
        if (createdNew) deleteNotebook(nbID);
        failStart(e, nbName);
      }
    }

    console.log(`URL:   ${url}`);
    console.log(`ID:    ${nbID}`);
    console.log(`PID:   ${pid}`);

    if (!isEmbedded && opts.open) {
      openInBrowser(url);
    }
  });

function requireUiAlreadyRunning(): void {
  const ui = readUiState();
  if (ui && isAlive(ui.pid, ui.pidStartTs)) {
    if (ui.url) return;
    console.error('nbm UI is still starting.');
    console.error('Wait until `nbm ui` says it is ready, then run this command again.');
    Deno.exit(1);
  }

  if (ui) {
    clearUiState();
  }

  console.error('nbm UI is not running.');
  console.error('Embedded mode needs the UI before starting a notebook.');
  console.error('Run `nbm ui` in another terminal, wait for it to be ready, then run this command again.');
  Deno.exit(1);
}

async function spawn(
  nbPath: string,
  nb: Notebook,
  extraArgs: string[],
  isEmbedded: boolean,
): Promise<{ pid: number; url: string }> {
  const { pid, url, logPath } = await runNotebook(
    nb.id,
    nb.type,
    nbPath,
    nb.runtime,
    isEmbedded,
    extraArgs,
  );
  console.log(`Log:   ${logPath}`);
  return { pid, url };
}

function failStart(e: unknown, nbName: string): never {
  console.error(`\nFailed to start ${nbName}.`);
  console.error(e instanceof Error ? e.message : String(e));
  Deno.exit(1);
}
