#!/usr/bin/env -S deno run -A
/**
 * Build a single platform binary.
 *
 * Usage: deno run -A scripts/build-binary.ts <plat-arch> [--version <semver>]
 *
 *   plat-arch: darwin-arm64 | linux-x64
 *   --version: version to bake into the binary's `nbm --version` output.
 *              Defaults to the version field in npm/nbm/package.json.
 *
 * Outputs:  dist/<plat-arch>/bin/nbm
 *
 * Steps:
 *   1. Resolve the version (CLI flag, else npm/nbm/package.json).
 *   2. Build the SvelteKit app (`pnpm --dir apps/web build`).
 *   3. Patch apps/cli/main.ts's VERSION literal to the resolved version.
 *   4. `deno compile --target <triple> --include apps/web/build ...`.
 *   5. Restore main.ts.
 */

import { dirname, fromFileUrl, join, resolve } from 'jsr:@std/path@1';

const TARGETS: Record<string, string> = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
};

const REPO_ROOT = resolve(dirname(fromFileUrl(import.meta.url)), '..');
const MAIN_TS = join(REPO_ROOT, 'apps/cli/main.ts');
const VERSION_TS = join(REPO_ROOT, 'apps/cli/version.ts');
const PNPM_PACKAGE_JSON = join(REPO_ROOT, 'npm/nbm/package.json');
const WEB_BUILD = join(REPO_ROOT, 'apps/web/build');
const VERSION_RE = /export const VERSION = '[^']*';/;

function usage(): never {
  console.error('Usage: build-binary.ts <darwin-arm64|linux-x64> [--version <semver>]');
  Deno.exit(2);
}

async function main() {
  const args = Deno.args.slice();
  const platArch = args.shift();
  if (!platArch || !TARGETS[platArch]) usage();

  let version: string | undefined;
  while (args.length) {
    const a = args.shift();
    if (a === '--version') version = args.shift();
    else usage();
  }
  if (!version) {
    try {
      const pkg = JSON.parse(await Deno.readTextFile(PNPM_PACKAGE_JSON));
      version = pkg.version;
    } catch {
      console.error(`Could not read version from ${PNPM_PACKAGE_JSON}; pass --version.`);
      Deno.exit(2);
    }
  }
  if (!version) usage();

  const target = TARGETS[platArch];
  const outDir = join(REPO_ROOT, 'dist', platArch, 'bin');
  const outBin = join(outDir, 'nbm');
  await Deno.mkdir(outDir, { recursive: true });

  console.log(`-- Building nbm@${version} for ${platArch} (${target})`);

  console.log('-- Building SvelteKit web app');
  await run(['pnpm', '--dir', 'apps/web', 'build'], { cwd: REPO_ROOT });
  try {
    await Deno.stat(join(WEB_BUILD, 'handler.js'));
  } catch {
    console.error(`Web build did not produce ${join(WEB_BUILD, 'handler.js')}`);
    Deno.exit(1);
  }

  // Bundle handler.js with esbuild so it has zero npm runtime deps. Without
  // this, deno compile must walk the workspace's pnpm node_modules tree to
  // resolve runtime imports like `shiki`, ballooning the binary by ~160 MB.
  // After bundling, all npm code is inlined into one file and `deno compile`
  // is set to skip node_modules walking entirely.
  console.log('-- Bundling SvelteKit handler with esbuild');
  await run(
    [
      'pnpm',
      'exec',
      'esbuild',
      join(WEB_BUILD, 'handler.js'),
      '--bundle',
      '--platform=node',
      '--format=esm',
      `--outfile=${join(WEB_BUILD, 'handler.bundled.js')}`,
      '--external:node:*',
    ],
    { cwd: REPO_ROOT },
  );
  // Replace handler.js with the bundled output so the runtime loader (which
  // imports build/handler.js) gets the dep-free version.
  await Deno.rename(
    join(WEB_BUILD, 'handler.bundled.js'),
    join(WEB_BUILD, 'handler.js'),
  );
  // The bundle inlines everything from server/, env.js, shims.js, and the
  // standalone index.js. Drop the originals so deno compile doesn't re-scan
  // them and (re-)pull in npm deps via their JSDoc / dynamic imports.
  for (const dead of ['server', 'env.js', 'shims.js', 'index.js']) {
    const p = join(WEB_BUILD, dead);
    try {
      await Deno.remove(p, { recursive: true });
    } catch {
      // already gone or not produced — fine.
    }
  }

  console.log(`-- Patching ${VERSION_TS} with VERSION='${version}'`);
  const original = await Deno.readTextFile(VERSION_TS);
  if (!VERSION_RE.test(original)) {
    console.error(`Could not find VERSION literal in ${VERSION_TS}`);
    Deno.exit(1);
  }
  const patched = original.replace(VERSION_RE, `export const VERSION = '${version}';`);
  await Deno.writeTextFile(VERSION_TS, patched);

  let compileError: unknown;
  try {
    console.log(`-- deno compile --target ${target}`);
    // --no-check: SvelteKit's build emits JSDoc type imports of npm packages
    // (polka, sirv, @standard-schema/spec, @opentelemetry/api) that aren't
    // installed; they're type-only and not used at runtime, but `deno check`
    // refuses them. The runtime is unaffected.
    await run(
      [
        'deno',
        'compile',
        '--no-check',
        '--target',
        target,
        '--allow-all',
        '--include',
        WEB_BUILD,
        '--config',
        join(REPO_ROOT, 'apps/cli/deno.json'),
        '--output',
        outBin,
        MAIN_TS,
      ],
      { cwd: REPO_ROOT },
    );
  } catch (e) {
    compileError = e;
  }
  // Always restore version.ts before exiting, success or fail.
  await Deno.writeTextFile(VERSION_TS, original);
  if (compileError) {
    console.error(compileError instanceof Error ? compileError.message : compileError);
    Deno.exit(1);
  }

  // Mark executable on POSIX (deno compile output is already executable on
  // the host platform, but cross-target outputs may not be).
  try {
    await Deno.chmod(outBin, 0o755);
  } catch {
    // Windows host: skip.
  }

  const stat = await Deno.stat(outBin);
  console.log(`-- Done: ${outBin} (${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
}

async function run(cmd: string[], opts: { cwd: string }) {
  const c = new Deno.Command(cmd[0], {
    args: cmd.slice(1),
    cwd: opts.cwd,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const status = await c.spawn().status;
  if (!status.success) {
    throw new Error(`Command failed (exit ${status.code}): ${cmd.join(' ')}`);
  }
}

if (import.meta.main) await main();
