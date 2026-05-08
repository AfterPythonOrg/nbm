import { Command } from '@cliffy/command';
import { runUiForeground } from '../ui.ts';

export const uiCommand = new Command()
  .description('Start the nbm web ui (blocks until you stop it with Ctrl+C).')
  .option('-p, --port <port:number>', 'Port for the ui server (auto-picks if omitted).')
  .action(async ({ port }) => {
    await runUiForeground(port);
  });
