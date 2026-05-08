import { Command } from '@cliffy/command';
import { DEFAULT_WORKSPACE_NAME } from '@nbm/core';
import type { Notebook, Runtime } from '@nbm/core';
import { resolveNotebook, updateNotebookRuntime } from '../notebook.ts';
import { findSessionById, removeSession } from '../sessions.ts';
import { isAlive } from '../process.ts';

function assertExecutablePath(path: string, label: string): void {
  if (!path.trim()) throw new Error(`${label} is required.`);
  if (!path.startsWith('/')) throw new Error(`${label} must be an absolute path.`);
  let info: Deno.FileInfo;
  try {
    info = Deno.statSync(path);
  } catch {
    throw new Error(`${label} does not exist: ${path}`);
  }
  if (!info.isFile) throw new Error(`${label} must point to a file: ${path}`);
  if (((info.mode ?? 0) & 0o111) === 0) throw new Error(`${label} is not executable: ${path}`);
}

function assertProjectPath(path: string): void {
  if (!path.startsWith('/')) throw new Error('Runtime project must be an absolute path.');
  try {
    Deno.statSync(path);
  } catch {
    throw new Error(`Runtime project does not exist: ${path}`);
  }
}

function buildRuntime(nb: Notebook, binary: string, project?: string): Runtime {
  const runtimeBinary = binary.trim();
  const runtimeProject = project?.trim() ?? '';
  assertExecutablePath(runtimeBinary, 'Runtime binary');
  if (runtimeProject) {
    if (nb.type !== 'pluto') throw new Error('Runtime project is only supported for Pluto notebooks.');
    assertProjectPath(runtimeProject);
  }
  return runtimeProject ? { binary: runtimeBinary, project: runtimeProject } : { binary: runtimeBinary };
}

function resolveRuntimeTarget(target: string): Notebook | undefined {
  const slashIdx = target.indexOf('/');
  if (slashIdx > 0 && slashIdx < target.length - 1) {
    const workspace = target.slice(0, slashIdx);
    const name = target.slice(slashIdx + 1);
    return resolveNotebook(name, workspace);
  }
  return resolveNotebook(target, DEFAULT_WORKSPACE_NAME);
}

const setCommand = new Command()
  .description('Set the runtime for an existing stopped notebook.')
  .arguments('<workspaceNotebookOrId:string>')
  .option('--binary <path:string>', 'Absolute path to the runtime binary.', { required: true })
  .option('--project <path:string>', 'Julia project path (Pluto only).')
  .action((opts, workspaceNotebookOrId) => {
    const nb = resolveRuntimeTarget(workspaceNotebookOrId);
    if (!nb) {
      console.error(`No notebook found for: ${workspaceNotebookOrId}`);
      Deno.exit(1);
    }

    const session = findSessionById(nb.id);
    if (session && isAlive(session.pid, session.pidStartTs)) {
      console.error(`Stop ${nb.name} before changing its runtime.`);
      Deno.exit(1);
    }
    if (session) removeSession(nb.id);

    try {
      const runtime = buildRuntime(nb, opts.binary, opts.project);
      const updated = updateNotebookRuntime(nb.id, runtime);
      if (!updated) throw new Error(`No notebook found for: ${workspaceNotebookOrId}`);
      console.log(`Runtime for ${updated.name} = ${updated.runtime.binary}`);
      if (updated.runtime.project) console.log(`Project = ${updated.runtime.project}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      Deno.exit(1);
    }
  });

export const runtimeCommand = new Command()
  .description('Manage per-notebook runtime settings.')
  .action(function () {
    this.showHelp();
  })
  .command('set', setCommand);
