import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { getHomeDir } from '@nbm/core';
import { spawnDetached, isAlive, terminateProcessGroup } from './process.ts';
import { openInBrowser } from './browser.ts';

// In `deno compile` output, Deno.execPath() points at the compiled binary
// (e.g. /usr/local/bin/nbm). In `deno run`, it points at the deno runtime.
// We use this to switch UI launch strategy.
function isCompiled(): boolean {
  const exe = Deno.execPath().toLowerCase();
  return !exe.endsWith('/deno') && !exe.endsWith('\\deno.exe') && !exe.endsWith('/deno.exe');
}

export type UiState = {
  pid: number;
  pidStartTs: string;
  url: string;
  startedAt: string;
};

export function getUiStatePath(): string {
  return join(getHomeDir(), 'ui.json');
}

export function getUiLogPath(): string {
  return join(getHomeDir(), 'ui.log');
}

export function readUiState(): UiState | undefined {
  const path = getUiStatePath();
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as UiState;
}

export function writeUiState(state: UiState): void {
  const path = getUiStatePath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, path);
}

export function clearUiState(): void {
  const path = getUiStatePath();
  if (existsSync(path)) rmSync(path);
}

// nbm's UI process appears as either a vite dev server (dev mode) or a
// `__serve-ui` self-spawn (compiled binary). Match either. Vite's command
// line can be absolute or relative depending on cwd, so we also confirm
// ownership via cwd (set to apps/web by ensureUiRunning).
const UI_CMD_RE = /\bvite\/bin\/vite\.js\b|\bnbm\b.*\b__serve-ui\b/;

type UiProcess = { pid: number; pgid: number; command: string };

function psSnapshot(): UiProcess[] {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,pgid=,command='], {
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 16 * 1024 * 1024,
    }).toString();
    const rows: UiProcess[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) continue;
      rows.push({ pid: Number(m[1]), pgid: Number(m[2]), command: m[3] });
    }
    return rows;
  } catch {
    return [];
  }
}

function getCwd(pid: number): string | null {
  try {
    // `-a` ANDs the `-p` and `-d` filters; without it lsof ORs them.
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    const m = out.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Find vite/__serve-ui processes that look like nbm UI instances.
 * Confirms ownership by checking the process cwd points at an `apps/web` dir
 * — vite is widely used outside nbm too, and we don't want to reach into
 * unrelated projects.
 */
export function findNbmUiProcesses(): UiProcess[] {
  const result: UiProcess[] = [];
  for (const row of psSnapshot()) {
    if (!UI_CMD_RE.test(row.command)) continue;
    // For __serve-ui, the binary is nbm itself — no cwd check needed.
    if (!/__serve-ui/.test(row.command)) {
      const cwd = getCwd(row.pid);
      if (cwd && !cwd.includes('/apps/web')) continue;
    }
    result.push(row);
  }
  return result;
}

/**
 * Kill all nbm UI processes except one (typically the one we just adopted or
 * spawned). Used by ensureUiRunning to enforce the "exactly one UI" invariant
 * regardless of how stragglers got created (interrupted spawns, ui.json
 * deletion, parallel races).
 */
function killUiOrphansExcept(keepPid: number | null): void {
  for (const p of findNbmUiProcesses()) {
    if (p.pid === keepPid) continue;
    try {
      // SIGTERM by pid (not pgid). Older nbm versions launched vite without
      // setsid, so those leftover processes share a pgid with the user's
      // interactive shell — group-kill would also kill the shell.
      process.kill(p.pid, 'SIGTERM');
    } catch {
      // already dead / permission denied — ignore
    }
  }
}

/**
 * Returns the running ui state. If not running, spawns it.
 * Idempotent: used by `nbm ui` to attach to an existing UI or create one.
 * Always returns immediately — the UI runs detached in the background. For
 * the interactive, blocking command path, use `runUiForeground`.
 *
 * `started` is true when this call spawned a new UI process; false when an
 * already-running instance was reused. Callers can use this to decide whether
 * to open a browser tab.
 */
export async function ensureUiRunning(port?: number): Promise<UiState & { started: boolean }> {
  const existing = readUiState();
  if (existing && isAlive(existing.pid, existing.pidStartTs)) {
    // Defensive sweep: kill any other nbm UI processes that escaped tracking.
    // These accumulate when `nbm start` is interrupted between spawning vite
    // and writing ui.json (e.g. user Ctrl+C, URL-capture timeout, parallel
    // races). vite is detached via setsid so it survives the parent's death,
    // and without ui.json updated the next `nbm start` would spawn yet
    // another. Sweeping here closes the loop.
    killUiOrphansExcept(existing.pid);
    return { ...existing, started: false };
  }
  if (existing) {
    clearUiState();
  }
  // No tracked UI — kill any untracked vite/__serve-ui survivors before
  // spawning a fresh one, so we don't pile up.
  killUiOrphansExcept(null);

  // Compiled binary: self-spawn into `__serve-ui` mode. The child imports the
  // embedded SvelteKit handler and serves it via node:http, printing
  // `http://localhost:<port>` on listen so the parent's URL scrape works.
  // Dev mode (`deno run`): spawn vite from the workspace, since the source
  // tree is on disk and we want hot reload.
  let binary: string;
  let args: string[];
  let cwd: string | undefined;
  if (isCompiled()) {
    binary = Deno.execPath();
    args = ['__serve-ui', '--port', String(port ?? 0)];
  } else {
    // Resolve the workspace root from this file's source location.
    // import.meta.url → file:///.../apps/cli/ui.ts → workspace root is two up.
    const cliDir = dirname(fileURLToPath(import.meta.url));
    const webRoot = join(cliDir, '..', 'web');
    binary = join(webRoot, 'node_modules', '.bin', 'vite');
    args = ['dev'];
    if (port !== undefined) args.push('--port', String(port));
    cwd = webRoot;
  }

  const startedAt = new Date().toISOString();
  const { pid, pidStartTs, url } = await spawnDetached(
    binary,
    args,
    getUiLogPath(),
    cwd,
    {
      // Persist the pid as soon as it's captured, before we wait (potentially
      // up to 60s) for vite to print its URL. Without this, an interrupt or
      // URL-capture timeout would leak an untracked detached vite — the next
      // `nbm start` would see no ui.json and spawn yet another, piling up.
      onPidCaptured: ({ pid, pidStartTs }) => {
        writeUiState({ pid, pidStartTs, url: '', startedAt });
      },
    },
  );

  const state: UiState = { pid, pidStartTs, url, startedAt };
  writeUiState(state);
  return { ...state, started: true };
}

/**
 * Start (or attach to) the UI and block the calling terminal until either the
 * user signals (Ctrl+C / SIGTERM) or the UI process dies on its own. On exit,
 * SIGTERMs the UI and clears state. This is what `nbm ui` should call so that
 * the user has a foreground handle they can close.
 */
export async function runUiForeground(port?: number): Promise<void> {
  const logPath = getUiLogPath();
  const existing = readUiState();
  let state: UiState;

  if (existing && isAlive(existing.pid, existing.pidStartTs)) {
    state = existing;
    console.log(`nbm UI already running at ${state.url} (pid ${state.pid})`);
    console.log('Attached. Press Ctrl+C to stop the UI.');
  } else {
    if (existing) clearUiState();
    const target = port === undefined ? 'first available port' : `port ${port}`;
    console.log(`Starting nbm UI (${target})...`);
    console.log(`Log: ${logPath}`);
    console.log('Waiting for the local URL...');
    try {
      state = await ensureUiRunning(port);
    } catch (e) {
      console.error('');
      console.error('Failed to start nbm UI.');
      console.error(e instanceof Error ? e.message : String(e));
      console.error(`Log: ${logPath}`);
      Deno.exit(1);
    }
    console.log('');
    console.log('nbm UI is ready');
    console.log(`Open: ${state.url}`);
    console.log(`PID:  ${state.pid}`);
    console.log('Press Ctrl+C to stop.');
    openInBrowser(state.url);
  }

  await waitForSignalOrDeath(state.pid, state.pidStartTs);

  if (isAlive(state.pid, state.pidStartTs)) {
    console.log('\nStopping nbm UI...');
    const ok = await terminateProcessGroup(state.pid, state.pidStartTs);
    if (!ok) {
      console.error(`Failed to stop pid ${state.pid}`);
    }
  } else {
    console.log('\nnbm UI exited.');
  }
  clearUiState();
}

function waitForSignalOrDeath(pid: number, pidStartTs: string): Promise<void> {
  return new Promise<void>((resolve) => {
    let resolved = false;
    const done = () => {
      if (resolved) return;
      resolved = true;
      Deno.removeSignalListener('SIGINT', done);
      Deno.removeSignalListener('SIGTERM', done);
      clearInterval(poll);
      resolve();
    };
    Deno.addSignalListener('SIGINT', done);
    Deno.addSignalListener('SIGTERM', done);
    const poll = setInterval(() => {
      if (!isAlive(pid, pidStartTs)) done();
    }, 1000);
  });
}
