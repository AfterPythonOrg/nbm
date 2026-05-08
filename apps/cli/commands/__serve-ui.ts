import { Command } from '@cliffy/command';
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getHomeDir } from '@nbm/core';
import { VERSION } from '../version.ts';

// The SvelteKit handler streams static assets via fs.createReadStream, which
// fails against `deno compile`'s embedded virtual filesystem ("Failed to get
// OS file descriptor"). Extract the build to a real disk path on first run
// (cached by binary version), then load the handler from there so its
// import.meta.url and asset reads resolve to real files.
async function ensureBuildOnDisk(): Promise<string> {
  const target = join(getHomeDir(), 'web-build', VERSION);
  const sentinel = join(target, '.extracted');
  if (existsSync(sentinel)) return target;

  // Resolve the embedded build dir relative to this module. In `deno run`
  // dev, this is the actual on-disk apps/web/build/. In a compiled binary,
  // this URL points into the VFS, but Deno's fs walker can read it.
  const here = dirname(fileURLToPath(import.meta.url));
  const embedded = join(here, '..', '..', 'web', 'build');

  mkdirSync(target, { recursive: true });
  await copyTreeFromVfs(embedded, target);
  writeFileSync(sentinel, '');
  return target;
}

async function copyTreeFromVfs(src: string, dst: string): Promise<void> {
  for await (const entry of Deno.readDir(src)) {
    const s = join(src, entry.name);
    const d = join(dst, entry.name);
    if (entry.isDirectory) {
      mkdirSync(d, { recursive: true });
      await copyTreeFromVfs(s, d);
    } else if (entry.isFile) {
      const data = await Deno.readFile(s);
      writeFileSync(d, data);
    }
  }
}

export const __serveUiCommand = new Command()
  .description('(internal) Serve the embedded nbm web UI. Used by `nbm ui`.')
  .hidden()
  .option('-p, --port <port:number>', 'Port to listen on. 0 = auto-pick.', { default: 0 })
  .action(async ({ port }) => {
    let buildDir: string;
    try {
      buildDir = await ensureBuildOnDisk();
    } catch (e) {
      console.error('nbm: failed to extract embedded web build.');
      console.error(e instanceof Error ? e.message : String(e));
      console.error('In dev, run `pnpm --dir apps/web build` first.');
      Deno.exit(1);
    }

    const handlerPath = join(buildDir, 'handler.js');
    if (!existsSync(handlerPath) || !statSync(handlerPath).isFile) {
      console.error(`nbm: SvelteKit handler not found at ${handlerPath}.`);
      Deno.exit(1);
    }

    // Dynamic file:// import of the extracted handler.
    // deno-lint-ignore no-explicit-any
    let handler: any;
    try {
      const url = new URL(`file://${handlerPath}`).href;
      const mod = await import(url);
      handler = mod.handler;
    } catch (e) {
      console.error('nbm: failed to load SvelteKit handler.');
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }

    const server = createServer(handler);
    server.listen(port, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : port;
      console.log(`http://localhost:${actualPort}`);
    });
    const stop = () => {
      server.close(() => Deno.exit(0));
      setTimeout(() => Deno.exit(0), 1000);
    };
    Deno.addSignalListener('SIGINT', stop);
    Deno.addSignalListener('SIGTERM', stop);
  });
