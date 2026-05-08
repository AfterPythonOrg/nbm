import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_MODE, getConfigPath } from '@nbm/core';
import type { Mode } from '@nbm/core';

type FieldSpec<T extends string = string> = {
  default: T;
  allowed?: readonly T[];
  description: string;
};

// Add new fields here. Type-safe and self-documenting.
export const FIELDS = {
  mode: {
    default: DEFAULT_MODE satisfies Mode,
    allowed: ['standalone', 'embedded'] as const satisfies readonly Mode[],
    description: 'How notebooks are displayed: standalone (own browser tab) or embedded (in nbm ui).',
  },
  nextRunningKeybinding: {
    default: 'Alt+J',
    description: 'Shortcut for activating the next running notebook. Alt is Option on macOS.',
  },
  previousRunningKeybinding: {
    default: 'Alt+K',
    description: 'Shortcut for activating the previous running notebook. Alt is Option on macOS.',
  },
} as const satisfies Record<string, FieldSpec>;

export type ConfigKey = keyof typeof FIELDS;
type ValueOf<F> = F extends { allowed: readonly (infer V)[] } ? V : string;
export type Config = { [K in ConfigKey]: ValueOf<(typeof FIELDS)[K]> };

function defaultConfig(): Config {
  const c = {} as Config;
  for (const key of Object.keys(FIELDS) as ConfigKey[]) {
    (c as Record<string, string>)[key] = FIELDS[key].default;
  }
  return c;
}

export function readConfig(): Config {
  const path = getConfigPath();
  const base = defaultConfig();
  if (!existsSync(path)) return base;
  const stored = JSON.parse(readFileSync(path, 'utf8')) as Partial<Config>;
  return { ...base, ...stored };
}

export function writeConfig(c: Config): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(c, null, 2));
  renameSync(tmp, path);
}

export function isValidKey(key: string): key is ConfigKey {
  return Object.hasOwn(FIELDS, key);
}

export function validateValue(key: ConfigKey, value: string): void {
  const spec = FIELDS[key] as { allowed?: readonly string[] };
  if (spec.allowed && !spec.allowed.includes(value)) {
    throw new Error(`Invalid value for '${key}'. Allowed: ${spec.allowed.join(', ')}`);
  }
}

export function getValue(key: ConfigKey): string {
  return readConfig()[key];
}

export function setValue(key: ConfigKey, value: string): void {
  validateValue(key, value);
  const c = readConfig();
  (c as Record<string, string>)[key] = value;
  writeConfig(c);
}
