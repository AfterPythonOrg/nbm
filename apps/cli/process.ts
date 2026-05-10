import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { getSessionLogPath, getProcessStartTime, isAlive, type SpawnResult } from '@nbm/core';
import { upsertSession } from './sessions.ts';

// Re-export read-side helpers from core so callers can keep importing from this module.
export { getProcessStartTime, isAlive, killProcessGroup, terminateProcessGroup } from '@nbm/core';

const URL_REGEX = /https?:\/\/(?:localhost|127\.0\.0\.1)\S*/;
const URL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 200;
const PID_TIMEOUT_MS = 2_000;

function shEscape(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Resolve a portable setsid prefix once. Required so each spawn becomes a new
// session/process-group leader (PGID == PID) — that's what lets nbm stop kill
// the whole tree via `kill -- -PID` rather than just the leader.
//
//   - Linux: util-linux ships /usr/bin/setsid.
//   - macOS: no setsid binary; use perl, which ships at /usr/bin/perl on
//     every macOS install since 10.x and exposes POSIX::setsid.
let cachedSetsidPrefix: string | null = null;
function setsidPrefix(): string {
  if (cachedSetsidPrefix !== null) return cachedSetsidPrefix;
  if (existsSync('/usr/bin/setsid')) {
    cachedSetsidPrefix = '/usr/bin/setsid';
  } else if (existsSync('/usr/bin/perl')) {
    // perl -e '... setsid; exec @ARGV' -- binary args...
    cachedSetsidPrefix =
      `/usr/bin/perl -e ${shEscape('use POSIX qw(setsid); setsid(); exec { $ARGV[0] } @ARGV or die "exec: $!\\n"')} --`;
  } else {
    throw new Error(
      'No setsid mechanism available: neither /usr/bin/setsid nor /usr/bin/perl exists. ' +
        'nbm needs one of these to put each notebook into its own process group.',
    );
  }
  return cachedSetsidPrefix;
}

export type DetachedProcess = {
  pid: number;
  pidStartTs: string;
  url: string;
  logPath: string;
};

export type SpawnHooks = {
  // Called as soon as the child's pid + start-time are captured, before we
  // wait for it to print a URL. Lets callers persist tracking state up front
  // so a Ctrl+C or URL-capture timeout during the wait doesn't leak an
  // untracked process.
  onPidCaptured?: (info: { pid: number; pidStartTs: string }) => void;
};

/**
 * Spawn a long-running process detached from nbm, in a fresh process group.
 *
 * Uses sh -c with a setsid-equivalent prefix so the child becomes a session
 * leader (PGID == PID). Every grandchild marimo/jupyter/pluto forks (LSP
 * servers, copilot, julia background tasks) inherits this pgid, which lets
 * `nbm stop` reach them via `kill -- -PID`. Without this, killing the leader
 * by PID alone orphans its children to launchd (PPID=1).
 *
 * Stdout/stderr go to logPath so the child outlives nbm without a broken
 * pipe. Stdin is /dev/null. The shell writes the child PID to a sidecar file
 * so we don't depend on the launcher's exit ordering.
 */
export async function spawnDetached(
  binary: string,
  args: string[],
  logPath: string,
  cwd?: string,
  hooks?: SpawnHooks,
): Promise<DetachedProcess> {
  mkdirSync(dirname(logPath), { recursive: true });
  const pidPath = `${logPath}.pid`;
  if (existsSync(pidPath)) rmSync(pidPath);

  // setsid_wrapper exec's binary in a new session, so the recorded PID is
  // the binary's own pid AND its pgid. nohup ignores SIGHUP so the child
  // survives terminal close. `&` backgrounds it; `$!` is the backgrounded
  // pid (which exec-chains down to the binary).
  const parts = [
    setsidPrefix(),
    'nohup',
    shEscape(binary),
    ...args.map(shEscape),
    '>',
    shEscape(logPath),
    '2>&1',
    '<',
    '/dev/null',
    '&',
    'echo',
    '$!',
    '>',
    shEscape(pidPath),
  ];
  const cd = cwd ? `cd ${shEscape(cwd)} || exit 1; ` : '';
  const cmd = `${cd}${parts.join(' ')}`;

  new Deno.Command('sh', {
    args: ['-c', cmd],
    stdout: 'null',
    stderr: 'null',
    stdin: 'null',
  }).spawn();

  const pid = await waitForPid(pidPath, PID_TIMEOUT_MS);
  if (!Number.isFinite(pid) || pid <= 0) {
    throw new Error('Could not parse PID from spawn output.');
  }

  const pidStartTs = getProcessStartTime(pid);
  if (!pidStartTs) {
    // ps -p PID returned nothing, which on macOS/Linux means the process is
    // already gone. Almost always: the spawned binary exited within a few ms
    // (missing module, bad arg, etc.). Surface the log so the user sees the
    // real error instead of "Could not capture start time".
    const logTail = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim() : '';
    throw new Error(
      `Process (pid ${pid}) exited before nbm could track it.\n--- log ---\n${logTail || '(empty)'}\n--- end log ---`,
    );
  }

  hooks?.onPidCaptured?.({ pid, pidStartTs });

  const url = await waitForUrl(logPath, pid, pidStartTs, URL_TIMEOUT_MS);
  if (!url) {
    throw new Error(
      `Process started (pid ${pid}) but URL not captured within ${URL_TIMEOUT_MS / 1000}s. See ${logPath}`,
    );
  }

  return { pid, pidStartTs, url, logPath };
}

async function waitForPid(pidPath: string, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        rmSync(pidPath, { force: true });
        return pid;
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Could not capture spawned process PID. See ${pidPath}`);
}

export async function spawnAndTrack(
  notebookId: string,
  binary: string,
  args: string[],
): Promise<SpawnResult> {
  const logPath = getSessionLogPath(notebookId);
  const { pid, pidStartTs, url } = await spawnDetached(binary, args, logPath);

  const port = Number(new URL(url).port) || 0;
  upsertSession({
    notebookId,
    pid,
    port,
    url,
    pidStartTs,
    startedAt: new Date().toISOString(),
  });

  return { pid, url, logPath };
}

async function waitForUrl(
  logPath: string,
  pid: number,
  pidStartTs: string,
  timeoutMs: number,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(logPath)) {
      const content = readFileSync(logPath, 'utf8');
      const m = content.match(URL_REGEX);
      if (m) return m[0];
      // Process died before printing a URL — surface its log so the user sees
      // the underlying error (missing dep, bad arg, etc.) instead of waiting
      // for the URL timeout.
      if (!isAlive(pid, pidStartTs)) {
        throw new Error(
          `Process (pid ${pid}) exited before printing a URL.\n--- log ---\n${content.trim() || '(empty)'}\n--- end log ---`,
        );
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}
