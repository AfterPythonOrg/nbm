import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { getHomeDir } from '@nbm/core';

const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 1000;
const REGISTRY_URL = 'https://registry.npmjs.org/nbm/latest';

type Cache = { checkedAt: number; latest: string };

function cachePath(): string {
  return join(getHomeDir(), 'update-check.json');
}

function readCache(): Cache | undefined {
  const path = cachePath();
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Cache;
  } catch {
    return undefined;
  }
}

function writeCache(c: Cache): void {
  const path = cachePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(c));
}

function isNewer(latest: string, current: string): boolean {
  // Treat any non-equal version where `latest` is lexicographically after the
  // current as newer. Good enough for semver bumps, conservative for prerelease.
  if (latest === current) return false;
  const norm = (v: string) => v.split('-')[0].split('.').map((p) => parseInt(p, 10) || 0);
  const a = norm(latest);
  const b = norm(current);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return false;
}

/**
 * Kicks off a non-blocking update check. Returns a promise that resolves to
 * the latest version (or undefined if not checked / failed). Skipped if:
 *   - NBM_NO_UPDATE_CHECK=1
 *   - cache is fresh (<24h)
 *   - argv is just `--version` / `--help` / nothing
 *   - argv contains `__serve-ui` (the internal subcommand)
 *   - current is a `-dev.*` build
 */
export function runUpdateCheck(currentVersion: string): Promise<string | undefined> {
  if (Deno.env.get('NBM_NO_UPDATE_CHECK') === '1') return Promise.resolve(undefined);
  if (currentVersion.includes('-dev')) return Promise.resolve(undefined);
  const argv = Deno.args;
  if (argv.length === 0) return Promise.resolve(undefined);
  if (argv.includes('--version') || argv.includes('-V')) return Promise.resolve(undefined);
  if (argv.includes('--help') || argv.includes('-h')) return Promise.resolve(undefined);
  if (argv[0] === '__serve-ui') return Promise.resolve(undefined);

  const cached = readCache();
  if (cached && Date.now() - cached.checkedAt < CHECK_TTL_MS) {
    return Promise.resolve(cached.latest);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  return fetch(REGISTRY_URL, { signal: ctrl.signal })
    .then((r) => (r.ok ? r.json() : undefined))
    .then((j: { version?: string } | undefined) => {
      clearTimeout(t);
      const latest = j?.version;
      if (latest) writeCache({ checkedAt: Date.now(), latest });
      return latest;
    })
    .catch(() => {
      clearTimeout(t);
      return undefined;
    });
}

/** After the main command finishes, print one stderr line if outdated. */
export async function maybePrintUpdateNotice(
  check: Promise<string | undefined>,
  currentVersion: string,
): Promise<void> {
  let latest: string | undefined;
  try {
    latest = await Promise.race([
      check,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 100)),
    ]);
  } catch {
    return;
  }
  if (!latest) return;
  if (!isNewer(latest, currentVersion)) return;
  console.error(
    `\nnbm ${latest} is available — run \`npm install -g nbm@latest\` to upgrade. ` +
      `(set NBM_NO_UPDATE_CHECK=1 to disable)`,
  );
}
