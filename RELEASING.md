# Releasing `nbm`

The release pipeline is **tag-driven**: pushing a `vX.Y.Z` tag triggers
[.github/workflows/release.yml](.github/workflows/release.yml), which builds
three platform binaries and publishes four packages to npm.

---

## Packaging architecture

End-user UX: `npm install -g nbm` → global `nbm` command.

Implementation: a single-file native executable produced by `deno compile`
is shipped over npm using the standard "binary via optionalDependencies"
pattern (esbuild / biome / swc / turbo all use this).

### Four packages on npm, same version

```
nbm                              ← the user installs this
  bin/nbm.js                       40-line Node launcher
  optionalDependencies:
    @nbm/cli-darwin-arm64          contains bin/nbm (Mach-O)
    @nbm/cli-darwin-x64            contains bin/nbm (Mach-O)
    @nbm/cli-linux-x64             contains bin/nbm (ELF)
```

Each platform package declares `"os"` + `"cpu"`, so npm only installs the
matching one. The launcher resolves the installed platform package's binary
and `spawnSync`s it.

### What's inside each binary (~88 MB)

- Deno runtime
- `apps/cli/` source (compiled by `deno compile`)
- `packages/core/` (as TS, via the deno.json import map; build-time only)
- `apps/web/build/` (Node-compatible SvelteKit `adapter-node` output, with
  `packages/core` already fused in by vite)
- JSR deps `@cliffy/command`, `@std/assert`

User has no Deno, no separate Node-running-our-code, no external runtime
deps for nbm itself. (External notebook runtimes — python+marimo/jupyter,
julia+Pluto — are still the user's responsibility; they're runtime deps of
the *notebooks*.)

### How `nbm ui` works in the packaged binary

1. User runs `nbm ui`.
2. CLI calls `ensureUiRunning(port)` in [apps/cli/ui.ts](apps/cli/ui.ts).
3. That self-spawns the same compiled binary into a hidden subcommand:
   `Deno.execPath() __serve-ui --port N`.
4. The hidden command in [apps/cli/commands/__serve-ui.ts](apps/cli/commands/__serve-ui.ts)
   extracts the embedded SvelteKit `build/` to `~/.nbm/web-build/<version>/`
   on first run (workaround: `createReadStream` fails against Deno's
   compiled virtual filesystem), then loads `handler.js` and serves it via
   `node:http`. Prints `http://localhost:<port>` on listen.
5. The parent scrapes the URL from the log file, persists state to
   `~/.nbm/ui.json`, opens the browser, and (for foreground `nbm ui`) blocks
   until Ctrl+C.

In dev mode (`deno run apps/cli/main.ts`) the same code path detects it's
not running from a compiled binary (via `Deno.execPath()` ending in
`/deno`) and spawns `vite dev` from the workspace instead, preserving hot
reload during development.

### Repo file map

| Path | Purpose |
|---|---|
| [apps/cli/main.ts](apps/cli/main.ts) | Cliffy entry, registers all commands incl. hidden `__serve-ui`. |
| [apps/cli/version.ts](apps/cli/version.ts) | Single source of truth for `VERSION`. `scripts/build-binary.ts` string-replaces this literal at compile time. |
| [apps/cli/ui.ts](apps/cli/ui.ts) | UI lifecycle. Dual-mode dispatch (vite in dev, self-spawn in compiled). |
| [apps/cli/commands/__serve-ui.ts](apps/cli/commands/__serve-ui.ts) | Hidden subcommand. Extracts the embedded SvelteKit build to `~/.nbm/web-build/<version>/` on first run, then loads `handler.js` and serves via `node:http`. |
| [apps/cli/update-check.ts](apps/cli/update-check.ts) | Non-blocking npm registry check (24h cache). Prints a one-liner if outdated. Disabled by `NBM_NO_UPDATE_CHECK=1`, on `--version`/`--help`, on `__serve-ui`, and on `-dev` builds. |
| [apps/web/](apps/web/) | SvelteKit app (`adapter-node`). No source changes for packaging — vite handles the workspace import of `@nbm/core` at build time. |
| [packages/core/](packages/core/) | Shared workspace package. Private; never published. Bundled twice into the binary (once as TS via Deno's import map, once as JS via vite's web build). |
| [scripts/build-binary.ts](scripts/build-binary.ts) | One platform build. `pnpm --dir apps/web build` → bundle SvelteKit handler with esbuild → patch [version.ts](apps/cli/version.ts) → `deno compile --no-check --include apps/web/build` → restore version.ts. |
| [scripts/release.sh](scripts/release.sh) | Bump version across all four `npm/*/package.json`s, commit, tag, push. |
| [.github/workflows/release.yml](.github/workflows/release.yml) | Tag-driven matrix (`macos-14`, `macos-13`, `ubuntu-24.04`) → upload artifacts → publish all four packages. |
| [npm/nbm/](npm/nbm/) | User-facing launcher package. `bin/nbm.js` resolves the platform binary and `spawnSync`s it. |
| [npm/cli-darwin-arm64/](npm/cli-darwin-arm64/), [npm/cli-darwin-x64/](npm/cli-darwin-x64/), [npm/cli-linux-x64/](npm/cli-linux-x64/) | Platform-specific package.json templates declaring `os`/`cpu`. CI populates `bin/nbm` from build artifacts. |

### Why we bundle the SvelteKit handler with esbuild before `deno compile`

The SvelteKit `adapter-node` build emits `handler.js` plus a tree of server
chunks under `build/server/` that import real npm packages at runtime
(`shiki` for code preview, `polka`, `sirv`, `cookie` from the adapter
itself). If those imports remain, `deno compile` walks the workspace's pnpm
`node_modules` to resolve them — and pnpm's hoisting drags in 140 MB of
**dev-only** tooling (TypeScript, rolldown, vite plugins, etc.) along with
the real runtime deps. The binary explodes from ~88 MB to ~244 MB.

Workaround in [scripts/build-binary.ts](scripts/build-binary.ts): after the
SvelteKit build, run esbuild to bundle `handler.js` + everything it imports
(including all npm deps) into a single self-contained file with `node:*` as
the only externals. Replace `handler.js` with the bundled output, delete the
now-redundant `server/`, `env.js`, `shims.js`, `index.js`. Then set
`"nodeModulesDir": "none"` in the workspace `deno.json` so `deno compile`
skips node_modules walking entirely.

### Why `--no-check` on `deno compile`

SvelteKit's `adapter-node` build output (`apps/web/build/handler.js`) has
JSDoc `@type` comments referencing npm packages like `polka`, `sirv`,
`@standard-schema/spec`, `@opentelemetry/api`. These are **type-only**
references, not runtime imports — the polka/sirv code itself is bundled
inline by SvelteKit. `deno check` flags them anyway. `--no-check` skips the
check; runtime is unaffected.

### Why the build is extracted to disk on first run

`deno compile`'s embedded virtual filesystem supports `Deno.readFile` and
`fs.readFileSync` against included assets, but **not** `fs.createReadStream`
("Failed to get OS file descriptor"). SvelteKit's adapter-node uses
`createReadStream` for static asset serving (via the bundled `sirv`).
Workaround in [__serve-ui.ts](apps/cli/commands/__serve-ui.ts): on first
run for a given binary version, walk the embedded `apps/web/build/` tree
via `Deno.readDir` + `Deno.readFile` and write it out to
`~/.nbm/web-build/<VERSION>/`. Subsequent runs use the cached extraction.

---

## One-time setup (do once, ever)

1. Reserve the unscoped name `nbm` and the `@nbm` org on npm. (If `@nbm` is
   taken, change every reference to `@nbm/cli-*-*` in
   [npm/nbm/package.json](npm/nbm/package.json),
   [npm/nbm/bin/nbm.js](npm/nbm/bin/nbm.js), and the three
   [npm/cli-*-*/package.json](npm/) files.)
2. Generate an npm token: <https://www.npmjs.com/settings/~/tokens>, type
   "Automation", scope "Publish".
3. Add it to GitHub: repo → Settings → Secrets → Actions →
   `NPM_TOKEN = <token>`.

## Cutting a release

```sh
./scripts/release.sh 0.1.0
```

What happens:

1. Sanity checks: clean working tree, on `main`, up-to-date with origin,
   tag doesn't already exist.
2. Bumps version in `npm/nbm/package.json` and the three platform packages
   (and the `optionalDependencies` references) to match.
3. Commits `release: v0.1.0`, tags `v0.1.0`, pushes the branch and tag.
4. Prints a link to the running GitHub Actions workflow.

CI then:

1. Builds three binaries in parallel (macOS arm64 on `macos-14`, macOS x64 on
   `macos-13`, Linux x64 on `ubuntu-24.04`).
2. Each job runs [scripts/build-binary.ts](scripts/build-binary.ts), which
   does `pnpm --dir apps/web build` then `deno compile`.
3. Smoke-tests `--version` on the freshly built binary.
4. Uploads each binary as an artifact.
5. The publish job downloads all three, populates `npm/cli-*-*/bin/nbm`,
   and runs `npm publish` on each platform package, then on `nbm`.

After it's green: `npm install -g nbm@0.1.0` works for any user on a supported
platform. Total wall-clock time: ~5–10 minutes.

## Local one-off binary build (no publish)

For testing changes before tagging:

```sh
deno run -A scripts/build-binary.ts darwin-arm64
# → dist/darwin-arm64/bin/nbm
```

You can move the resulting binary anywhere and run it; it has no runtime deps
beyond the external notebook tools (python+marimo/jupyter, julia+Pluto).

## Recovery

### CI failed before publishing anything

Re-run the failed jobs from the GitHub UI: Actions → failed run →
"Re-run failed jobs". The build is deterministic from the tagged commit.

### CI failed mid-publish (one platform package published, another didn't)

Don't retag. The version that already published is locked. Fix the issue
and run `./scripts/release.sh 0.1.1` (or whatever next semver). On the next
release the launcher's `optionalDependencies` will reference the new version
of every package and everything realigns.

### A bad version went out

Within 72 hours of publish:

```sh
npm unpublish nbm@0.1.0 --force
npm unpublish @nbm/cli-darwin-arm64@0.1.0 --force
npm unpublish @nbm/cli-darwin-x64@0.1.0 --force
npm unpublish @nbm/cli-linux-x64@0.1.0 --force
```

After 72 hours, deprecate instead:

```sh
npm deprecate nbm@0.1.0 "broken; use 0.1.1 or later"
```

Then `./scripts/release.sh 0.1.1`.

### Smoke from a clean machine

After a release, sanity-check on a machine that doesn't have your dev
environment:

```sh
npm install -g nbm@0.1.0
nbm --version
nbm ui          # opens browser, dashboard loads
nbm start ~/some-notebook.py
```

If something fails:

```sh
npm uninstall -g nbm
# fix bug in repo
./scripts/release.sh 0.1.1
```
