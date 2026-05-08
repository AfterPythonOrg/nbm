import { Command, EnumType } from '@cliffy/command';
import { listNotebooks } from '../notebook.ts';
import { findSessionById } from '../sessions.ts';
import { isAlive } from '../process.ts';

const notebookType = new EnumType(['marimo', 'jupyter', 'pluto']);

export const listCommand = new Command()
  .description('List notebooks. By default only running notebooks are shown.')
  .type('nbtype', notebookType)
  .option('-a, --all', 'Include stopped notebooks.')
  .option('-w, --workspace <name:string>', 'Filter by workspace.')
  .option('-t, --type <type:nbtype>', 'Filter by notebook type.')
  .action((opts) => {
    const notebooks = listNotebooks();
    if (notebooks.length === 0) {
      console.log('No notebooks registered.');
      return;
    }

    const allRows = notebooks.map((nb) => {
      const session = findSessionById(nb.id);
      const running = !!(session && isAlive(session.pid, session.pidStartTs));
      const status = running ? `running ${session!.url}` : 'stopped';
      return { id: nb.id, name: nb.name, type: nb.type, workspace: nb.workspace, status, running };
    });

    const rows = allRows.filter((r) => {
      if (opts.workspace && r.workspace !== opts.workspace) return false;
      if (opts.type && r.type !== opts.type) return false;
      if (!opts.all && !r.running) return false;
      return true;
    });

    if (rows.length === 0) {
      const parts: string[] = [];
      if (opts.type) parts.push(`type=${opts.type}`);
      if (opts.workspace) parts.push(`workspace=${opts.workspace}`);
      const where = parts.length ? ` (${parts.join(', ')})` : '';
      if (opts.all) {
        console.log(`No notebooks found${where}.`);
      } else {
        console.log(`No running notebooks${where}. Run 'nbm list --all' to include stopped ones.`);
      }
      return;
    }

    const colWidths = {
      id: 8,
      name: Math.max(4, ...rows.map((r) => r.name.length)),
      type: Math.max(4, ...rows.map((r) => r.type.length)),
      workspace: Math.max(9, ...rows.map((r) => r.workspace.length)),
    };

    const pad = (s: string, w: number) => s.padEnd(w);
    console.log(
      `${pad('ID', colWidths.id)}  ${pad('NAME', colWidths.name)}  ${pad('TYPE', colWidths.type)}  ${pad('WORKSPACE', colWidths.workspace)}  STATUS`,
    );
    for (const r of rows) {
      console.log(
        `${pad(r.id, colWidths.id)}  ${pad(r.name, colWidths.name)}  ${pad(r.type, colWidths.type)}  ${pad(r.workspace, colWidths.workspace)}  ${r.status}`,
      );
    }
  });
