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
 * SIGTERM a process group, wait up to `graceMs` for the leader to die, then
 * SIGKILL the group if still alive. Returns true once the leader is gone.
 */
export async function terminateProcessGroup(
  pid: number,
  pidStartTs: string,
  graceMs = 3000,
): Promise<boolean> {
  if (!isAlive(pid, pidStartTs)) return true;

  killProcessGroup(pid, 'SIGTERM');

  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid, pidStartTs)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }

  killProcessGroup(pid, 'SIGKILL');
  // Brief final check — SIGKILL is uncatchable, this should always succeed.
  await new Promise((r) => setTimeout(r, 200));
  return !isAlive(pid, pidStartTs);
}
