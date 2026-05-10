import { execFileSync } from 'node:child_process';
import process from 'node:process';

export function getProcessStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const s = out.toString().trim();
    return s || null;
  } catch {
    return null;
  }
}

/**
 * Walk the descendant process tree of `rootPid` by PPID and return every
 * descendant's PID. Needed because runners like marimo spawn LSP helpers
 * (pylsp, the node-based marimo LSP) with `start_new_session=True`, putting
 * them in their own process group — so SIGTERM-the-group misses them and
 * they linger after the parent dies.
 */
function getDescendantPids(rootPid: number): number[] {
  let out: string;
  try {
    out = execFileSync('ps', ['-A', '-o', 'pid=,ppid='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
  } catch {
    return [];
  }
  const childrenOf = new Map<number, number[]>();
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const arr = childrenOf.get(ppid);
    if (arr) arr.push(pid);
    else childrenOf.set(ppid, [pid]);
  }
  const result: number[] = [];
  const queue = [rootPid];
  while (queue.length) {
    const p = queue.shift()!;
    for (const c of childrenOf.get(p) ?? []) {
      result.push(c);
      queue.push(c);
    }
  }
  return result;
}

function killPid(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  try {
    process.kill(pid, signal);
  } catch (e) {
    // ESRCH = already gone, that's fine. Swallow other errors too — best-effort.
    if ((e as NodeJS.ErrnoException).code !== 'ESRCH') {
      // unexpected (EPERM, etc.) — nothing actionable here
    }
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isAlive(pid: number, pidStartTs: string): boolean {
  const current = getProcessStartTime(pid);
  if (current === null) return false;
  if (current === pidStartTs) return true;

  const currentTime = Date.parse(current);
  const sessionTime = Date.parse(pidStartTs);
  return Number.isFinite(currentTime) && currentTime === sessionTime;
}

/**
 * Send a signal to a whole POSIX process group. Pass the group leader's PID
 * (which equals the PGID for sessions started via `setsid`/`detached:true`).
 *
 * Returns true if the signal was delivered (or there was nothing to deliver
 * to), false on unexpected errors. Missing-process (ESRCH) is treated as
 * success since the goal — "nothing in this group is alive" — is met.
 */
export function killProcessGroup(pgid: number, signal: 'SIGTERM' | 'SIGKILL'): boolean {
  try {
    // Negative PID = process group. Node's process.kill maps to libc kill(2).
    process.kill(-pgid, signal);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return true;
    return false;
  }
}

/**
 * SIGTERM a process group + its descendant tree, wait up to `graceMs` for
 * the leader to die, then SIGKILL anything still alive. Returns true once
 * the leader is gone.
 *
 * Why both group AND tree: setsid puts the leader's direct children in the
 * same process group, so `kill -- -pgid` reaches them. But helpers spawned
 * with their own new session (e.g. marimo's pylsp + node LSP, started via
 * Python's start_new_session=True) leave that group and would otherwise
 * survive. We snapshot the descendant tree by PPID up front and sweep it
 * explicitly.
 */
export async function terminateProcessGroup(
  pid: number,
  pidStartTs: string,
  graceMs = 3000,
): Promise<boolean> {
  if (!isAlive(pid, pidStartTs)) return true;

  // Snapshot descendants now — once the leader dies and children get
  // reparented to launchd/init, walking from the leader's pid no longer
  // finds them.
  const descendants = getDescendantPids(pid);

  killProcessGroup(pid, 'SIGTERM');
  for (const d of descendants) killPid(d, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid, pidStartTs)) break;
    await new Promise((r) => setTimeout(r, 100));
  }

  // Always sweep with SIGKILL — even if the leader exited gracefully, an
  // out-of-group LSP child may still be alive and ignored SIGTERM.
  killProcessGroup(pid, 'SIGKILL');
  for (const d of descendants) {
    if (pidAlive(d)) killPid(d, 'SIGKILL');
  }
  await new Promise((r) => setTimeout(r, 200));
  return !isAlive(pid, pidStartTs);
}
