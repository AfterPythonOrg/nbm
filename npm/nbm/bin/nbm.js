#!/usr/bin/env node
// Tiny Node launcher. Resolves the platform binary installed via
// optionalDependencies and execs it. Exits with the child's status.
'use strict';

const { spawnSync } = require('node:child_process');

const PACKAGES = {
  'darwin-arm64': '@afterpython/nbm-cli-darwin-arm64',
  'darwin-x64': '@afterpython/nbm-cli-darwin-x64',
  'linux-x64': '@afterpython/nbm-cli-linux-x64',
};

const key = `${process.platform}-${process.arch}`;
const pkg = PACKAGES[key];

if (!pkg) {
  console.error(
    `nbm: no prebuilt binary for ${key}. ` +
      `Supported: ${Object.keys(PACKAGES).join(', ')}.`,
  );
  process.exit(1);
}

let binPath;
try {
  binPath = require.resolve(`${pkg}/bin/nbm`);
} catch (e) {
  console.error(
    `nbm: ${pkg} is not installed. ` +
      `Try reinstalling: npm install -g @afterpython/nbm --force`,
  );
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), {
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) {
  console.error(`nbm: failed to spawn binary: ${result.error.message}`);
  process.exit(1);
}

if (result.signal) {
  // Re-raise the same signal so the parent shell sees the right exit reason.
  process.kill(process.pid, result.signal);
  return;
}

process.exit(result.status == null ? 1 : result.status);
