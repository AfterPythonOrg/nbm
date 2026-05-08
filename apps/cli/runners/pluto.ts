import type { Runtime } from '@nbm/core';
import { spawnAndTrack } from '../process.ts';

export function spawnPluto(
  nbID: string,
  nbPath: string,
  runtime: Runtime,
  isEmbedded: boolean,
  extraArgs: string[] = [],
) {
  // Pluto.run(notebook=path) only OPENS — it doesn't create. Ask Pluto to
  // write a fresh notebook first if the file is missing, using its own writer.
  //
  // launch_browser=false: nbm owns browser opening after it captures the URL
  // in standalone mode. Embedded mode renders through the already-running nbm
  // UI. Without this, Pluto would open a stray system tab in embedded mode.
  //
  // The @async block forces stdout/stderr to flush periodically. When Julia's
  // stdio is redirected to a file (no tty), it's fully-buffered — Pluto's
  // "URL: http://..." line would sit in the buffer indefinitely while Pluto
  // stays alive, so nbm's URL poller would time out. The flusher pushes those
  // bytes to the log file every 500ms.
  //
  // Shutdown contract: Pluto.run blocks until the server stops; we wrap it in
  // try/finally + exit(0) so that if Pluto returns OR throws (SIGINT, SIGTERM
  // bouncing off Julia's runtime, internal error), Julia tears down cleanly.
  // Without the explicit exit, a partially-shut-down Pluto plus surviving HTTP
  // tasks can spin at 100% CPU until something SIGKILLs them. nbm's
  // terminateProcessGroup() will SIGKILL after a 3s grace anyway, but exiting
  // proactively closes the window entirely.
  // Embedded-only require_secret_for_*=false: Pluto's default auth flow sets a
  // SameSite=Strict cookie, which browsers don't include on cross-origin iframe
  // requests (nbm UI at :5173, Pluto at :1234). Standalone keeps Pluto's
  // default secret behavior because the browser opens Pluto directly.
  const securityArgs = isEmbedded
    ? ', require_secret_for_access=false, require_secret_for_open_links=false'
    : '';
  const julia =
    `using Pluto; ` +
    `isfile("${nbPath}") || Pluto.save_notebook(Pluto.Notebook(Pluto.Cell[], "${nbPath}")); ` +
    `@async while true; flush(stdout); flush(stderr); sleep(0.5); end; ` +
    `try; ` +
    `Pluto.run(notebook="${nbPath}", launch_browser=false${securityArgs}); ` +
    `catch e; ` +
    `(e isa InterruptException) || println(stderr, "pluto exited: ", e); ` +
    `finally; ` +
    `exit(0); ` +
    `end`;

  const args: string[] = [];
  if (runtime.project) args.push(`--project=${runtime.project}`);
  args.push('-e', julia);
  args.push(...extraArgs);

  return spawnAndTrack(nbID, runtime.binary, args);
}
