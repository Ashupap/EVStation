import { buildApp } from './app.js';
import { createJwtVerifier } from './auth.js';
import { loadConfig } from './config.js';
import { assertRuntimeRole, createDb } from './db.js';

const config = loadConfig();
const db = createDb(config.databaseUrlApp);
await assertRuntimeRole(db.pool);

const verifier = createJwtVerifier({
  issuer: config.oidcIssuer,
  audience: config.oidcAudience,
  jwksUri: config.oidcJwksUri,
});
const app = await buildApp({ db, config, verifier });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
