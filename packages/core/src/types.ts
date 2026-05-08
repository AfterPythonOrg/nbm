type NotebookType = 'marimo' | 'jupyter' | 'pluto';

type Workspace = {
  name: string;
};

type Runtime = {
  binary: string;  // this is the path to the binary, e.g. "python" or "julia"
  project?: string;  // used by julia to store the project path, used in "julia --project={project_path}"
};

type Notebook = {
  id: string;
  name: string;
  type: NotebookType;
  runtime: Runtime;
  workspace: string;
  createdAt: string; // ISO string
};

type Session = {
  notebookId: string;
  pid: number;
  port: number;
  url: string;
  // NOTE: store both the PID and the process's start time at spawn. 
  // To check liveness, ask the OS for the start time of that PID now. 
  pidStartTs: string;   // raw ps lstart string; opaque key
  startedAt: string; // ISO string
}

type Registry = {
  version: number;
  workspaces: Workspace[];
  notebooks: Notebook[];
}

type SpawnResult = {
  pid: number;
  url: string;
  logPath: string;
}

type Mode = 'embedded' | 'standalone';

export type {
  Notebook,
  NotebookType,
  Session,
  Registry,
  Workspace,
  Runtime,
  SpawnResult,
  Mode,
}
