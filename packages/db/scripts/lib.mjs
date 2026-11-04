import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const dbRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const repoRoot = path.resolve(dbRoot, '../..');
const composeEnvPath = path.join(repoRoot, 'infra/compose/.env');

export function parseEnvFile(file) {
  const vars = {};
  if (!fs.existsSync(file)) return vars;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    vars[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return vars;
}

export function composeEnv() {
  return parseEnvFile(composeEnvPath);
}

function requireValue(name, value) {
  if (!value) {
    throw new Error(
      `${name} is not set. Run pnpm dev:stack once (creates infra/compose/.env) ` +
        'or export DATABASE_URL_MIGRATOR / DATABASE_URL_OWNER / DATABASE_URL_APP.',
    );
  }
  return value;
}

export function dbCredentials() {
  const compose = composeEnv();
  const host = process.env.OUR_DB_HOST || 'localhost';
  const port = process.env.OUR_DB_HOST_PORT || compose.OUR_DB_HOST_PORT || '5432';
  const name = process.env.OUR_DB_NAME || 'evstation';
  const url = (user, password) =>
    `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:${port}/${name}`;

  const passwords = {
    migrator: process.env.OUR_DB_PASSWORD || compose.OUR_DB_PASSWORD,
    owner: process.env.OUR_DB_OWNER_PASSWORD || compose.OUR_DB_OWNER_PASSWORD,
    app: process.env.OUR_DB_APP_PASSWORD || compose.OUR_DB_APP_PASSWORD,
  };

  return {
    migrator: requireValue(
      'DATABASE_URL_MIGRATOR',
      process.env.DATABASE_URL_MIGRATOR || url('evstation', passwords.migrator),
    ),
    owner: requireValue(
      'DATABASE_URL_OWNER',
      process.env.DATABASE_URL_OWNER || url('evstation_owner', passwords.owner),
    ),
    app: requireValue(
      'DATABASE_URL_APP',
      process.env.DATABASE_URL_APP || url('evstation_app', passwords.app),
    ),
    passwords,
  };
}

export function migrationFiles() {
  const dir = path.join(dbRoot, 'sql');
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => ({ file, sql: fs.readFileSync(path.join(dir, file), 'utf8') }));
}

export function isCliEntry(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return metaUrl === pathToFileURL(path.resolve(entry)).href;
}
