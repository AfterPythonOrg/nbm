import { Command } from '@cliffy/command';
import { listCommand } from './commands/list.ts';
import { startCommand } from './commands/start.ts';
import { stopCommand } from './commands/stop.ts';
import { removeCommand } from './commands/remove.ts';
import { configCommand } from './commands/config.ts';
import { uiCommand } from './commands/ui.ts';
import { runtimeCommand } from './commands/runtime.ts';
import { __serveUiCommand } from './commands/__serve-ui.ts';
import { doctorCommand } from './commands/doctor.ts';
import { runUpdateCheck, maybePrintUpdateNotice } from './update-check.ts';
import { VERSION } from './version.ts';

const updateCheck = runUpdateCheck(VERSION);

await new Command()
  .name('nbm')
  .version(VERSION)
  .description('Notebook Manager')
  .action(function () {
    this.showHelp();
  })
  .command('list', listCommand).alias('ls')
  .command('start', startCommand)
  .command('stop', stopCommand)
  .command('remove', removeCommand).alias('rm')
  .command('config', configCommand)
  .command('runtime', runtimeCommand)
  .command('ui', uiCommand)
  .command('doctor', doctorCommand)
  .command('__serve-ui', __serveUiCommand)
  .parse(Deno.args);

await maybePrintUpdateNotice(updateCheck, VERSION);
