// scripts/build-binary.ts string-replaces this literal before `deno compile`,
// so the published binary reports the npm tag version. In dev (`deno run`),
// the literal is used as-is.
export const VERSION = '0.0.1-dev.1';
