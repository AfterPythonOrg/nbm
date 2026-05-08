import { Command } from '@cliffy/command';
import {
  FIELDS,
  isValidKey,
  readConfig,
  getValue,
  setValue,
  type ConfigKey,
} from '../config.ts';

const listCommand = new Command()
  .description('List all config values.')
  .action(() => {
    const c = readConfig();
    for (const key of Object.keys(FIELDS) as ConfigKey[]) {
      console.log(`${key} = ${c[key]}`);
    }
  });

const getCommand = new Command()
  .description('Get a config value.')
  .arguments('<key:string>')
  .action((_, key) => {
    if (!isValidKey(key)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Available: ${Object.keys(FIELDS).join(', ')}`);
      Deno.exit(1);
    }
    console.log(getValue(key));
  });

const setCommand = new Command()
  .description('Set a config value.')
  .arguments('<key:string> <value:string>')
  .action((_, key, value) => {
    if (!isValidKey(key)) {
      console.error(`Unknown config key: ${key}`);
      console.error(`Available: ${Object.keys(FIELDS).join(', ')}`);
      Deno.exit(1);
    }
    try {
      setValue(key, value);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
    console.log(`${key} = ${value}`);
  });

export const configCommand = new Command()
  .description('Manage nbm configuration.')
  .action(function () {
    this.showHelp();
  })
  .command('list', listCommand)
  .command('get', getCommand)
  .command('set', setCommand);
