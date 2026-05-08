// Opens a URL in the user's default browser. Detached and best-effort:
// failures fall back to printing the URL.
export function openInBrowser(url: string): void {
  const opener = Deno.build.os === 'darwin' ? 'open' : 'xdg-open';
  try {
    new Deno.Command(opener, {
      args: [url],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
    }).spawn();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}
