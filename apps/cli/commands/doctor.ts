import { Command } from '@cliffy/command';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { pruneOrphanSessions } from '@nbm/core';
import { listSessions } from '../sessions.ts';
import { isAlive, killProcessGroup } from '../process.ts';
import { clearUiState, readUiState } from '../ui.ts';

type Suspect = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  kind: 'marimo' | 'jupyter' | 'pluto';
};

type UiOrphan = {
  pid: number;
  ppid: number;
  pgid: number;
  command: string;
  kind: 'vite' | 'serve-ui';
};

// Patterns that identify a notebook process by its command line. Match on
// the workspace path in the command line — this is unique to nbm-managed
// notebooks and survives runtime argv rewrites that fool naive matchers
// (e.g. `python -m jupyter notebook` execs into `python /path/jupyter-notebook`,
// dropping the `-m jupyter` form, and `marimo edit` can do the same).
const PATTERNS: Array<{ kind: Suspect['kind']; re: RegExp }> = [
  { kind: 'marimo', re: /\.nbm\/workspaces\/[^\s]+\/marimo\// },
  { kind: 'jupyter', re: /\.nbm\/workspaces\/[^\s]+\/jupyter\// },
  { kind: 'pluto', re: /\.nbm\/workspaces\/[^\s]+\/pluto\// },
];

function snapshot(): Array<{ pid: number; ppid: number; pgid: number; command: string }> {
  // BSD ps (macOS) and procps ps (Linux) both accept this -o spec.
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 16 * 1024 * 1024,
  }).toString();

  const rows: Array<{ pid: number; ppid: number; pgid: number; command: string }> = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      pgid: Number(m[3]),
      command: m[4],
    });
  }
  return rows;
}

// nbm's UI process appears as either a vite dev server (dev mode) or a
// `__serve-ui` self-spawn (compiled binary). The dev-mode command line varies:
// it can show the absolute path (`/.../apps/web/node_modules/.bin/../vite/bin/vite.js dev`)
// or a relative one (`./node_modules/.bin/../vite/bin/vite.js dev`) depending on
// how nbm was invoked. We match on the `vite/bin/vite.js` suffix and confirm
// ownership via the process's cwd (which is always set to apps/web by ensureUiRunning).
const UI_PATTERNS: Array<{ kind: UiOrphan['kind']; re: RegExp }> = [
  { kind: 'vite', re: /\bvite\/bin\/vite\.js\b/ },
  { kind: 'serve-ui', re: /\bnbm\b.*\b__serve-ui\b/ },
];

// Get the working directory of a pid via lsof. Returns null on any failure
// (process gone, lsof missing, permission denied) so callers can fall back to
// "include it" rather than dropping a real orphan.
function getCwd(pid: number): string | null {
  try {
    // `-a` ANDs `-p` (pid filter) and `-d cwd` (fd filter); without it lsof
    // ORs them and dumps cwd for every process on the system.
    const out = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    // -Fn output: lines prefixed with field codes (p<pid>, f<fd>, n<name>).
    const m = out.match(/^n(.+)$/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function findOrphanUis(): UiOrphan[] {
  const tracked = readUiState();
  const trackedAlivePid = tracked && isAlive(tracked.pid, tracked.pidStartTs) ? tracked.pid : null;

  const orphans: UiOrphan[] = [];
  for (const row of snapshot()) {
    const match = UI_PATTERNS.find((p) => p.re.test(row.command));
    if (!match) continue;
    if (row.pid === trackedAlivePid) continue;
    // Vite is widely used; confirm this process belongs to nbm by verifying
    // its cwd points at an `apps/web` directory before flagging it as ours.
    if (match.kind === 'vite') {
      const cwd = getCwd(row.pid);
      if (cwd && !cwd.includes('/apps/web')) continue;
    }
    orphans.push({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      command: row.command,
      kind: match.kind,
    });
  }
  return orphans;
}

function findSuspects(): Suspect[] {
  const liveSessionPgids = new Set(
    listSessions()
      .filter((s) => isAlive(s.pid, s.pidStartTs))
      // PGID == PID for processes spawned via setsid/detached:true.
      .map((s) => s.pid),
  );

  const suspects: Suspect[] = [];
  for (const row of snapshot()) {
    const match = PATTERNS.find((p) => p.re.test(row.command));
    if (!match) continue;
    // A process is "owned" by an active session iff its pgid matches the
    // session leader's pid. Anything else is unaccounted for.
    if (liveSessionPgids.has(row.pgid)) continue;
    suspects.push({
      pid: row.pid,
      ppid: row.ppid,
      pgid: row.pgid,
      command: row.command,
      kind: match.kind,
    });
  }
  return suspects;
}

export const doctorCommand = new Command()
  .description(
    'Scan for orphaned notebook (marimo/jupyter/pluto) and UI (vite / nbm __serve-ui) ' +
      'processes not owned by any active nbm session, and optionally clean them up.',
  )
  .option('--kill', 'Kill the detected orphan process groups (SIGTERM, then SIGKILL).')
  .action(async (opts) => {
    const prunedSessions = pruneOrphanSessions();
    const suspects = findSuspects();
    const uiOrphans = findOrphanUis();
    const total = suspects.length + uiOrphans.length;

    if (total === 0) {
      if (prunedSessions.length > 0) {
        console.log(`Pruned ${prunedSessions.length} stale session file(s).`);
      }
      console.log('No orphan notebook or UI processes detected.');
      return;
    }

    // Group notebook suspects by pgid so we report (and kill) per-group.
    const groups = new Map<number, Suspect[]>();
    for (const s of suspects) {
      const arr = groups.get(s.pgid) ?? [];
      arr.push(s);
      groups.set(s.pgid, arr);
    }

    if (suspects.length > 0) {
      console.log(`Found ${suspects.length} orphan notebook process(es) across ${groups.size} group(s):\n`);
      for (const [pgid, members] of groups) {
        console.log(`  pgid ${pgid}  (${members.length} process${members.length === 1 ? '' : 'es'})`);
        for (const m of members) {
          const cmd = m.command.length > 110 ? m.command.slice(0, 107) + '...' : m.command;
          console.log(`    pid=${m.pid} ppid=${m.ppid} kind=${m.kind}  ${cmd}`);
        }
      }
    }

    if (uiOrphans.length > 0) {
      if (suspects.length > 0) console.log('');
      console.log(`Found ${uiOrphans.length} orphan UI process(es):\n`);
      for (const u of uiOrphans) {
        const cmd = u.command.length > 110 ? u.command.slice(0, 107) + '...' : u.command;
        console.log(`  pid=${u.pid} ppid=${u.ppid} pgid=${u.pgid} kind=${u.kind}  ${cmd}`);
      }
    }

    if (!opts.kill) {
      console.log('\nRe-run with --kill to terminate these processes.');
      return;
    }

    console.log('\nTerminating...');
    let failed = 0;
    for (const pgid of groups.keys()) {
      killProcessGroup(pgid, 'SIGTERM');
    }
    // UI orphans get killed by pid (not pgid). Older nbm versions launched
    // vite without setsid, so those leftover processes share a pgid with the
    // user's interactive shell — killing the group would also kill the shell.
    // Killing by pid is surgical; vite has no significant children to leak.
    for (const u of uiOrphans) {
      try {
        process.kill(u.pid, 'SIGTERM');
      } catch {
        // ignore — already dead or permission denied
      }
    }
    await new Promise((r) => setTimeout(r, 1500));

    // Anything still alive gets SIGKILL'd directly by pid (the pgid leader
    // may already be gone, leaving stragglers re-parented to launchd that
    // still hold ports).
    const stillAliveNb = findSuspects();
    const stillAliveUi = findOrphanUis();
    for (const s of [...stillAliveNb, ...stillAliveUi]) {
      try {
        process.kill(s.pid, 'SIGKILL');
      } catch {
        failed++;
      }
    }
    if (stillAliveNb.length + stillAliveUi.length > 0) {
      await new Promise((r) => setTimeout(r, 300));
    }

    // If the tracked UI was just killed (e.g. user ran `nbm doctor --kill`
    // and ui.json's pid is no longer alive), drop the stale state file so the
    // next command cleanly reports that `nbm ui` needs to be started again.
    const tracked = readUiState();
    if (tracked && !isAlive(tracked.pid, tracked.pidStartTs)) {
      clearUiState();
    }

    const remainingNb = findSuspects();
    const remainingUi = findOrphanUis();
    const remaining = remainingNb.length + remainingUi.length;
    if (remaining === 0) {
      console.log(`Cleaned ${total} process(es).`);
    } else {
      console.error(`Could not terminate ${remaining} process(es).`);
      Deno.exit(failed > 0 || remaining > 0 ? 1 : 0);
    }
  });
