#!/usr/bin/env node
/**
 * Start/stop the full local development stack (see docs/RUNBOOK.md).
 *
 *   dev-stack.mjs up    start everything (creating .env from .env.example)
 *   dev-stack.mjs down  stop everything (volumes kept)
 *   dev-stack.mjs down --volumes   also remove data volumes
 *   dev-stack.mjs logs [service...]
 *
 * The Compose project name is pinned to `evstation` and the env file is
 * passed explicitly, so the scripts work from any working directory.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeDir = path.join(repoRoot, 'infra/compose');
const composeFile = path.join(composeDir, 'docker-compose.yml');
const envFile = path.join(composeDir, '.env');
const envExample = path.join(composeDir, '.env.example');
const project = 'evstation';

const [, , command, ...args] = process.argv;

function composeArgs(extra) {
  // The Compose project directory is the directory of the -f file, so the
  // third_party/ relative mounts resolve correctly no matter the cwd.
  return [
    'compose',
    '--project-name',
    project,
    '--project-directory',
    composeDir,
    '--env-file',
    envFile,
    '-f',
    composeFile,
    ...extra,
  ];
}

function runCompose(extra, { capture = false } = {}) {
  const r = spawnSync('docker', composeArgs(extra), {
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (r.error) {
    console.error(`dev-stack: failed to run docker: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`dev-stack: docker compose failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  return capture ? r.stdout.toString() : '';
}

function ensureEnv() {
  if (fs.existsSync(envFile)) return;
  fs.copyFileSync(envExample, envFile);
  console.log(
    'dev-stack: created infra/compose/.env from .env.example (dev-only values; ' +
      'edit it for your machine, never commit the file).',
  );
}

switch (command) {
  case 'up': {
    ensureEnv();
    // Validate the merged config before touching Docker.
    spawnSync('docker', composeArgs(['config', '--quiet']), { stdio: 'inherit' });
    if (process.env.VERBOSE !== '1') {
      // Silence nothing by default; config above surfaces errors with context.
    }
    console.log('dev-stack: starting stack (images pull on first run)…');
    runCompose(['up', '-d', '--wait', '--wait-timeout', '600']);
    console.log('dev-stack: stack is up. See docs/RUNBOOK.md for the port map.');
    break;
  }
  case 'down': {
    const extra = args.includes('--volumes') ? ['-v'] : [];
    runCompose(['down', '--remove-orphans', ...extra]);
    if (!extra.length) {
      console.log('dev-stack: stopped (data volumes kept). Run down --volumes to wipe data.');
    }
    break;
  }
  case 'logs': {
    runCompose(['logs', '--tail=100', '-f', ...args]);
    break;
  }
  default: {
    console.error('usage: dev-stack.mjs up | down [--volumes] | logs [service…]');
    process.exit(1);
  }
}
