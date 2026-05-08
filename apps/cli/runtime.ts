import type { NotebookType, Runtime } from '@nbm/core';

export function captureRuntime(nbType: NotebookType): Runtime {
  const binary = whichBinary(runtimeBinary(nbType));
  switch (nbType) {
    case 'pluto':
      return { binary, project: captureJuliaProject(binary) };
    case 'marimo':
    case 'jupyter':
      return { binary };
  }
}

function runtimeBinary(nbType: NotebookType): 'python' | 'julia' {
  switch (nbType) {
    case 'marimo':
    case 'jupyter':
      return 'python';
    case 'pluto':
      return 'julia';
  }
}

function whichBinary(name: 'python' | 'julia'): string {
  const out = new Deno.Command('which', { args: [name], stdout: 'piped' }).outputSync();
  if (!out.success) throw new Error(`Could not find '${name}' on PATH.`);
  return new TextDecoder().decode(out.stdout).trim();
}

function captureJuliaProject(julia: string): string {
  const out = new Deno.Command(julia, {
    args: ['-e', 'print(dirname(Base.active_project()))'],
    stdout: 'piped',
  }).outputSync();
  if (!out.success) throw new Error('Could not detect Julia project.');
  return new TextDecoder().decode(out.stdout).trim();
}
