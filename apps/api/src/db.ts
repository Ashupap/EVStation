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
  const pool = new Pool({ connectionString, max });
  return {
    pool,
    async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
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
