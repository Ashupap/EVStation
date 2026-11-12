#!/usr/bin/env node
/**
 * Apply the committed Hasura adapter permission overlay. This is a bootstrap
 * step (admin secret) only; the adapter itself uses a Keycloak JWT role.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(repoRoot, 'infra/compose/.env');
const overlayFile = path.join(repoRoot, 'infra/compose/hasura/evstation-adapter-metadata.json');
const vars = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) vars[match[1]] = match[2].trim();
}
const secret = vars.HASURA_ADMIN_SECRET;
if (!secret) throw new Error('HASURA_ADMIN_SECRET is required');
const url = 'http://localhost:8090/v1/metadata';
const headers = { 'content-type': 'application/json', 'x-hasura-admin-secret': secret };
const overlay = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));

async function post(body) {
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hasura metadata failed: ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

const metadata = await post({ type: 'export_metadata', args: {} });
const source = metadata.sources?.find((item) => item.name === 'default');
if (!source) throw new Error('Hasura default source not found');
for (const [tableName, tableOverlay] of Object.entries(overlay.tables)) {
  const table = source.tables.find((item) => item.table?.name === tableName);
  if (!table) throw new Error(`Hasura table ${tableName} not found`);
  const roles = new Set([
    overlay.role,
    ...Object.values(tableOverlay).flatMap((items) =>
      Array.isArray(items) ? items.map((item) => item.role).filter(Boolean) : [],
    ),
  ]);
  for (const kind of ['select', 'insert', 'update', 'delete']) {
    const key = `${kind}_permissions`;
    table[key] = (table[key] ?? []).filter((permission) => !roles.has(permission.role));
  }
  for (const kind of ['select', 'insert', 'update']) {
    table[`${kind}_permissions`].push(...(tableOverlay[`${kind}_permissions`] ?? []));
  }
}
await post({ type: 'replace_metadata', args: metadata });
console.log('hasura-overlay: applied adapter role permissions');
