#!/usr/bin/env node
/**
 * Bootstrap the vendored-at-pin checkout of CitrineOS into third_party/.
 *
 * - Never copies CitrineOS source into our repo; third_party/ is git-ignored.
 * - Verifies that the upstream tag resolves to the pinned commit (peeled via
 *   ls-remote "<tag>^{}") and that the local checkout matches. Any mismatch
 *   is a hard failure: fix the pin, do not proceed.
 * - Idempotent: exits quickly when third_party is already at the right commit.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pinPath = path.join(repoRoot, 'infra/compose/citrineos.json');
const dest = path.join(repoRoot, 'third_party/citrineos-core');

function readPin() {
  const p = JSON.parse(fs.readFileSync(pinPath, 'utf8'));
  if (!p.repo || !p.ref || !p.commit || !Array.isArray(p.sparsePaths)) {
    fail('invalid pin file infra/compose/citrineos.json');
  }
  return p;
}

function fail(msg) {
  console.error(`bootstrap-citrineos: ERROR: ${msg}`);
  process.exit(1);
}

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts }).trim();
}

function run(args, opts = {}) {
  try {
    git(args, opts);
    return true;
  } catch {
    return false;
  }
}

const pin = readPin();
console.log(`bootstrap-citrineos: pin ${pin.repo} ${pin.ref} @ ${pin.commit.slice(0, 12)}…`);

// 1. Verify upstream truth: the tag (and, for annotated tags, its peeled
//    commit) must resolve to the pinned commit.
const lsRemote = git(['ls-remote', pin.repo, `refs/tags/${pin.ref}`, `refs/tags/${pin.ref}^{}`]);
const resolutions = lsRemote
  .split('\n')
  .map((line) => line.split('\t'))
  .filter(([sha, ref]) => sha && ref);
const hasTagRef = resolutions.some(([, ref]) => ref === `refs/tags/${pin.ref}`);
const hasMatchingResolution = resolutions.some(([sha]) => sha === pin.commit);
if (!hasTagRef) fail(`tag ${pin.ref} not found upstream at ${pin.repo}`);
if (!hasMatchingResolution) {
  fail(
    `upstream tag ${pin.ref} does not resolve to pin ${pin.commit} ` +
      `(got: ${resolutions.map(([sha, ref]) => `${ref}=${sha}`).join(', ')}). ` +
      `STOP and notify the project lead; do not continue.`,
  );
}
console.log(`bootstrap-citrineos: upstream verified (${pin.ref} resolves to pin)`);

// 2. Ensure the local checkout exists at the pin.
function headsToLocalHead() {
  try {
    return git(['-C', dest, 'rev-parse', 'HEAD']) === pin.commit;
  } catch {
    return false;
  }
}

if (fs.existsSync(path.join(dest, '.git'))) {
  if (!headsToLocalHead()) {
    console.log('bootstrap-citrineos: third_party checkout mismatch; re-cloning…');
    fs.rmSync(dest, { recursive: true, force: true });
  }
}

if (!fs.existsSync(path.join(dest, '.git'))) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`bootstrap-citrineos: sparse-cloning tag ${pin.ref} (depth 1, blob filter)…`);
  git([
    'clone',
    '--filter=blob:none',
    '--no-checkout',
    '--depth',
    '1',
    '--branch',
    pin.ref,
    pin.repo,
    dest,
  ]);
}

// 3. Configure sparse paths and materialize files.
run(['-C', dest, 'sparse-checkout', 'init', '--cone']);
run(['-C', dest, 'sparse-checkout', 'set', ...pin.sparsePaths]);
run(['-C', dest, 'checkout']);

// 4. Hard-verify the local HEAD and that the tag points at the pinned commit.
const head = git(['-C', dest, 'rev-parse', 'HEAD']);
const tagAt = git(['-C', dest, 'tag', '--points-at', 'HEAD']);
if (head !== pin.commit) {
  fail(`local checkout HEAD=${head} does not match pin ${pin.commit}`);
}
if (tagAt !== pin.ref) {
  fail(`local tag resolution: expected ${pin.ref} at HEAD, got "${tagAt}"`);
}

// 5. Sanity: required files must exist for the compose mounts.
const required = [
  'apps/ocpp-server/src/assets/roles-seed.json',
  'apps/ocpp-server/db/hasura-metadata/version.yaml',
  'apps/operator-ui/.env.local',
  'docker-compose.yml',
];
for (const rel of required) {
  if (!fs.existsSync(path.join(dest, rel))) fail(`missing file after checkout: ${rel}`);
}

console.log(
  `bootstrap-citrineos: OK — third_party/citrineos-core at ${pin.ref} (${head.slice(0, 12)}…) with sparse checkout`,
);
