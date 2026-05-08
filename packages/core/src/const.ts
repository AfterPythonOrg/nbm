import type { Mode, NotebookType } from './types.ts';

const REGISTRY_VERSION = 1;
const DEFAULT_WORKSPACE_NAME = 'default';
const DEFAULT_MODE: Mode = 'embedded';
const EXTENSION_TO_NB_TYPE: Record<string, NotebookType> = {
  '.py': 'marimo',
  '.jl': 'pluto',
  '.ipynb': 'jupyter',
};


export { REGISTRY_VERSION, DEFAULT_WORKSPACE_NAME, DEFAULT_MODE, EXTENSION_TO_NB_TYPE };