#!/usr/bin/env node
/**
 * Diff the SQL function bodies of two migrations and write an evidence log.
 *
 *   node packages/db/scripts/function-diff.mjs 0033_phase2b_review_fixes.sql \
 *     0034_phase2c_sse_notifications.sql > docs/evidence/phase2c-0034-function-diff.log
 *
 * Only the function bodies are compared: the diff shows what a reviewer needs
 * to judge, and it stays stable when unrelated statements move.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const dbRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sqlDir = path.join(dbRoot, 'sql');

/** Extracts `CREATE OR REPLACE FUNCTION app.<name>` bodies keyed by name. */
function functionBodies(sql) {
  const bodies = new Map();
  const pattern = /CREATE OR REPLACE FUNCTION app\.([a-z_]+)\([^)]*\)/g;
  for (const match of sql.matchAll(pattern)) {
    const name = match[1];
    const start = match.index + match[0].length;
    const quoteStart = sql.indexOf('$fn$', start);
    if (quoteStart < 0) continue;
    const bodyStart = quoteStart + '$fn$'.length;
    const bodyEnd = sql.indexOf('$fn$', bodyStart);
    if (bodyEnd < 0) continue;
    bodies.set(name, sql.slice(bodyStart, bodyEnd).replace(/^\n/, '').replace(/\n$/, ''));
  }
  return bodies;
}

function diffBodies(oldLabel, newLabel, oldBody, newBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evstation-fn-diff-'));
  const oldPath = path.join(dir, 'old.sql');
  const newPath = path.join(dir, 'new.sql');
  try {
    fs.writeFileSync(oldPath, oldBody);
    fs.writeFileSync(newPath, newBody);
    const result = spawnSync(
      'diff',
      ['-u', '--label', oldLabel, '--label', newLabel, oldPath, newPath],
      { encoding: 'utf8' },
    );
    // diff exits 1 when the bodies differ; that is the case we want to report.
    if (result.status === 0) return null;
    return result.stdout;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const [oldFile, newFile] = process.argv.slice(2);
if (!oldFile || !newFile) {
  console.error(
    'usage: node packages/db/scripts/function-diff.mjs <old-migration.sql> <new-migration.sql>',
  );
  process.exit(2);
}

const oldBodies = functionBodies(fs.readFileSync(path.join(sqlDir, oldFile), 'utf8'));
const newBodies = functionBodies(fs.readFileSync(path.join(sqlDir, newFile), 'utf8'));
const oldLabel = oldFile.slice(0, 4);
const newLabel = newFile.slice(0, 4);

const names = [...newBodies.keys()].sort();
for (const name of names) {
  const oldBody = oldBodies.get(name);
  const newBody = newBodies.get(name);
  if (oldBody === newBody) continue;
  const diff = diffBodies(
    `${oldLabel}/${name}`,
    `${newLabel}/${name}`,
    oldBody === undefined ? '' : `${oldBody}\n`,
    newBody === undefined ? '' : `${newBody}\n`,
  );
  if (diff === null) continue;
  process.stdout.write(`=== ${name} ===\n${diff}\n`);
}
