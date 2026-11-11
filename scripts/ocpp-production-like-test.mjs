#!/usr/bin/env node
/**
 * Phase 1 acceptance: apply the production-like OCPP overlay, prove an
 * unregistered station is refused while the seeded commissioned station still
 * boots Accepted, then restore the base dev stack.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeDir = path.join(repoRoot, 'infra/compose');
const baseCompose = [
  'compose',
  '--project-name',
  'evstation',
  '--project-directory',
  composeDir,
  '--env-file',
  path.join(composeDir, '.env'),
  '-f',
  path.join(composeDir, 'docker-compose.yml'),
];
const overlayCompose = [
  ...baseCompose,
  '-f',
  path.join(composeDir, 'docker-compose.production-like.yml'),
];

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    ...options,
  });
}

function compose(args, overlay) {
  const result = run('docker', [...(overlay ? overlayCompose : baseCompose), ...args]);
  if (result.status !== 0) {
    throw new Error(`docker compose ${args.join(' ')} failed\n${result.stdout}${result.stderr}`);
  }
}

const venvPython = path.join(repoRoot, '.venv/bin/python');
const python = process.env.SIM_PYTHON || (fs.existsSync(venvPython) ? venvPython : 'python3');
const simulator = path.join(repoRoot, 'tools/simulator/charger_simulator.py');
const url = 'ws://localhost:8081';

function runSimulator(args) {
  return run(python, [simulator, '--url', url, ...args], { timeout: 30_000 });
}

let unknownFailure;
let commissioned;
try {
  console.log('production-like OCPP: applying overlay with allowUnknownChargingStations=false');
  compose(['up', '-d', '--wait', 'citrine'], true);

  const unknownId = `UNKNOWN-${Date.now()}`;
  const unknown = runSimulator(['--id', unknownId, '--no-session']);
  const unknownOutput = `${unknown.stdout ?? ''}${unknown.stderr ?? ''}`;
  if (unknown.status === 0) throw new Error(`unregistered station ${unknownId} connected`);
  if (!/HTTP 404|rejected|closed/iu.test(unknownOutput)) {
    throw new Error(`unregistered station was not clearly refused:\n${unknownOutput}`);
  }
  console.log(`production-like OCPP: unregistered ${unknownId} refused (exit ${unknown.status})`);

  commissioned = runSimulator(['--id', 'cp001', '--exit-after-boot']);
  const commissionedOutput = `${commissioned.stdout ?? ''}${commissioned.stderr ?? ''}`;
  if (commissioned.status !== 0) {
    throw new Error(
      `commissioned station boot failed (exit ${commissioned.status}):\n${commissionedOutput}`,
    );
  }
  if (!/BootNotification\.status.*Accepted/u.test(commissionedOutput)) {
    throw new Error(`commissioned station did not boot Accepted:\n${commissionedOutput}`);
  }
  console.log('production-like OCPP: commissioned cp001 booted Accepted (exit 0)');
} catch (error) {
  unknownFailure = error;
  throw error;
} finally {
  console.log('production-like OCPP: restoring base dev stack');
  try {
    compose(['up', '-d', '--wait', 'citrine'], false);
  } catch (error) {
    if (!unknownFailure) throw error;
    console.error(`production-like OCPP: restore failed: ${error.message}`);
  }
}
