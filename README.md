# Notebook Manager (`nbm`)

A unified CLI and web dashboard for running and managing Jupyter, Marimo, and Pluto notebooks.

> *everything is vibe-coded including this README, No Quality Assurance*

## Features

- One tool for **Jupyter**, **Marimo**, and **Pluto** — engine picked from the file extension
- Organize notebooks into **workspaces**
- **Notebook explorer** — browse notebooks across workspaces, preview their code cells without running them, and double-click any notebook to start it
- **Per-notebook runtime memory** — nbm remembers which Python/Julia executable each notebook was created with, so you don't have to `cd` into the right project or activate the right env every time. `nbm start your_notebook.py` is enough.
- **Embedded** mode — run multiple notebooks inside one nbm UI and switch between them — or **standalone** mode, where each notebook runs on its own as usual
- Tracks running sessions; clean start/stop/remove

## Installation

```sh
npm install -g @afterpython/nbm
```

Supported platforms: macOS arm64, macOS x64, Linux x64.

External requirements (one or more, depending on which notebook engines you use):

- `python` with `marimo` (for `.py`) and/or `jupyter` (for `.ipynb`)
- `julia` with `Pluto` (for `.jl`)

`nbm` finds these on `PATH` at runtime; it doesn't bundle them.

## Quick start

```sh
nbm ui  # start the web UI
nbm start notebook.py                       # start a Marimo notebook
nbm start notebook.jl --workspace research  # start a Pluto notebook in the "research" workspace
nbm start notebook.ipynb -w experiment      # start a Jupyter notebook in the "experiment" workspace
```

The notebook engine is chosen from the file extension:

| Extension | Engine  |
|-----------|---------|
| `.py`     | Marimo  |
| `.ipynb`  | Jupyter |
| `.jl`     | Pluto   |

## Passing flags to the notebook engine

Anything you put after `--` on `nbm start` is forwarded verbatim to the underlying engine (`marimo edit` / `jupyter notebook`):

```sh
nbm start notebook.py -- --port 8765           # marimo edit ... --port 8765
nbm start notebook.ipynb -- --ServerApp.token=''  # jupyter notebook ... --ServerApp.token=''
```

Pluto doesn't take CLI flags this way, so `--` is effectively a no-op for `.jl` notebooks.

## Modes

`nbm` has two display modes (set with `nbm config set mode <value>`):

- **`embedded`** (default) — All running notebooks live **inside** the nbm UI. Start `nbm ui` first in another terminal, then run `nbm start` for each notebook; each running notebook gets its own tab in the sidebar, and you can cycle between them with `Alt+J` / `Alt+K`. Under the hood each notebook is rendered in its own iframe.

  > Rebind those shortcuts with `nbm config set nextRunningKeybinding <combo>` and `nbm config set previousRunningKeybinding <combo>` — e.g. `nbm config set nextRunningKeybinding Ctrl+Shift+J`. On macOS, `Alt` is the Option key.
- **`standalone`** — Notebooks run as their own normal web apps (just like running Jupyter/Marimo/Pluto by hand). `nbm ui` is optional and is only useful as a central overview.

If a notebook misbehaves in embedded mode (some notebook frontends don't love being framed), switch to standalone:

```sh
nbm config set mode standalone
```

## Commands

| Command | Description |
|---------|-------------|
| `nbm ui [-p, --port <port>]` | Start the web dashboard in the foreground (Ctrl+C to stop). Port auto-picks if omitted. |
| `nbm start <notebook> [-w, --workspace <name>] [--no-open] [-- <extra args>]` | Start (or create + start) a notebook. In embedded mode, `nbm ui` must already be running. In standalone mode, `--no-open` suppresses browser opening. Anything after `--` is passed through to the notebook runner. |
| `nbm stop <name\|id> [-w, --workspace <name>]` | Stop a running notebook. |
| `nbm stop all` | Stop every running notebook session. |
| `nbm stop ui` | Stop the embedded web UI. |
| `nbm list [-a, --all] [-w, --workspace <name>] [-t, --type <marimo\|jupyter\|pluto>]` (alias `ls`) | Table of id / name / type / workspace / status. By default only running notebooks are shown; pass `--all` to include stopped ones. `--workspace` and `--type` filter the list and compose with `--all`. |
| `nbm remove <name\|id> [-w, --workspace <name>]` (alias `rm`) | Stop the notebook, delete its registry entry and on-disk files. |
| `nbm config list \| get <key> \| set <key> <value>` | View or change configuration. |
| `nbm runtime set <workspace/name\|id> --binary <abs-path> [--project <abs-path>]` | Pin a Python/Julia binary to a notebook. The notebook must be stopped. `--project` is Pluto-only. |

When you omit `-w`, the workspace defaults to `default`.

## Runtime

When you first `nbm start` a notebook, nbm records the Python (or Julia) executable that's active in your shell at that moment and pins it to the notebook. Every later `nbm start` for that notebook reuses the same executable — no need to re-activate a venv, `cd` into the project, or remember which env it belongs to.

To change a notebook's runtime later (for example, to point a Marimo notebook at a different Python env):

```sh
nbm runtime set notebook.py --binary /abs/path/to/another/python
```

To target a notebook in a non-default workspace, use the `workspace/notebook` form (this slash syntax is **specific to `nbm runtime set`** — other commands use `--workspace` instead):

```sh
nbm runtime set research/notebook.py --binary /abs/path/to/another/python
```

For Pluto notebooks, you can also pin a Julia project directory:

```sh
nbm runtime set notebook.jl --binary /abs/path/to/julia --project /abs/path/to/JuliaProject
```

Notes:
- Paths must be absolute.
- The notebook must be stopped first (`nbm stop notebook.py`).
- You can also pass a notebook id instead of a name.

## Configuration

```sh
nbm config list
```

| Key | Default | Description |
|-----|---------|-------------|
| `mode` | `embedded` | `embedded` or `standalone` (see above). |
| `nextRunningKeybinding` | `Alt+J` | Shortcut to switch to the next running notebook in the sidebar. |
| `previousRunningKeybinding` | `Alt+K` | Shortcut to switch to the previous running notebook. |

On macOS, `Alt` is the Option key.

## Developers

- Stack: Deno CLI (Cliffy) + SvelteKit web dashboard, pnpm workspace, shared `@nbm/core` package.
- Layout: `apps/cli`, `apps/web`, `packages/core`.
- Requirements: pnpm 10+, Deno.
- Scripts (from [package.json](package.json)):
  - `pnpm dev:web` — run the web dashboard in dev mode
  - `pnpm dev:cli` — run the CLI in dev mode
  - `pnpm check` — type-check all packages
  - `pnpm lint` / `pnpm format`

### Releasing

Every release is one command — bump the version:

```sh
./scripts/release.sh 0.1.1
./scripts/release.sh 0.2.0
```

The script tags and pushes; CI builds the binaries and publishes the four
npm packages. See [RELEASING.md](RELEASING.md) for architecture and recovery.

## License

Apache-2.0
