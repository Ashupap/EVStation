import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export interface ApiDb {
  pool: Pool;
  transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T>;
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
  close(): Promise<void>;
}

export function createDb(connectionString: string, max = 10): ApiDb {
  const pool = new Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    query_timeout: 10_000,
    lock_timeout: 5_000,
    idle_in_transaction_session_timeout: 15_000,
  });
  pool.on('error', () => undefined);
  return {
    pool,
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      let failure: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release(failure);
      }
    },
    query<R extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
      return pool.query<R>(text, values);
    },
    async close() {
      await pool.end();
    },
  };
}

export interface RuntimeRole {
  role: string;
  superuser: boolean;
  bypassRls: boolean;
}

export async function inspectRuntimeRole(pool: Pool): Promise<RuntimeRole> {
  const { rows } = await pool.query<RuntimeRole>(
    `SELECT current_user AS role, rolsuper AS superuser, rolbypassrls AS "bypassRls"
     FROM pg_roles WHERE rolname = current_user`,
  );
  const row = rows[0];
  if (!row) throw new Error('cannot resolve the connected database role');
  return row;
}

export async function assertRuntimeRole(pool: Pool): Promise<void> {
  const role = await inspectRuntimeRole(pool);
  if (role.superuser || role.bypassRls) {
    throw new Error(
      `refusing to start: runtime role ${role.role} must not be superuser or BYPASSRLS`,
    );
  }
}
