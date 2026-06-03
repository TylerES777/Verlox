import { Pool, type PoolConfig } from 'pg';
import type {
  SqlColumn,
  SqlConnectConfig,
  SqlConnectResult,
  SqlQueryResult,
} from '@shared/types';

// SQL console connections — one live pool per tab id. Main owns them so the
// renderer never holds the database credential past the single connect call.
// v1 is Postgres only (node-postgres).

const pools = new Map<string, Pool>();

// Cap rows handed to the renderer so a huge SELECT can't flood the table.
const MAX_ROWS = 1000;
// Bound a single query and a connect attempt so a bad host/query can't hang
// the UI indefinitely.
const QUERY_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

function poolConfig(config: SqlConnectConfig): PoolConfig {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    // Managed Postgres (Railway/Supabase/RDS) terminates TLS with certs the
    // OS often doesn't trust; mirror the backend and don't reject unauthorized.
    ssl: config.ssl ? { rejectUnauthorized: false } : false,
    max: 4,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: QUERY_TIMEOUT_MS,
    query_timeout: QUERY_TIMEOUT_MS,
  };
}

// Turn a driver error into one calm, plain-English sentence.
function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ECONNREFUSED/i.test(msg)) return 'Could not reach that host and port.';
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return 'That host could not be found.';
  if (/ETIMEDOUT|timeout/i.test(msg)) return 'The database did not respond in time.';
  if (/password authentication failed|SASL/i.test(msg))
    return 'The username or password was rejected.';
  if (/database .* does not exist/i.test(msg))
    return 'That database does not exist on the server.';
  if (/self.signed|certificate|SSL/i.test(msg))
    return 'The database requires a secure connection; turn on SSL and try again.';
  return msg;
}

export async function sqlConnect(
  id: string,
  config: SqlConnectConfig,
): Promise<SqlConnectResult> {
  // Replace any existing connection on this tab.
  await sqlDisconnect(id);
  const pool = new Pool(poolConfig(config));
  // Swallow background pool errors so a dropped connection can't crash main.
  pool.on('error', () => {});
  try {
    const res = await pool.query('SELECT version() AS v');
    const banner = String(res.rows?.[0]?.v ?? '');
    const serverVersion = banner.split(' on ')[0] || undefined;
    pools.set(id, pool);
    return { ok: true, serverVersion };
  } catch (err) {
    await pool.end().catch(() => {});
    return { ok: false, error: friendlyError(err) };
  }
}

// Render any cell value as a string the table can show (or null).
function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export async function sqlQuery(id: string, sql: string): Promise<SqlQueryResult> {
  const empty = {
    columns: [] as SqlColumn[],
    rows: [] as Array<Array<string | null>>,
    rowCount: null,
    command: null,
    truncated: false,
    durationMs: 0,
  };
  const pool = pools.get(id);
  if (!pool) {
    return { ok: false, ...empty, error: 'Not connected to a database.' };
  }
  const started = Date.now();
  try {
    // rowMode 'array' gives rows aligned to fields order — preserves column
    // order and survives duplicate column names (which an object would merge).
    const res = await pool.query({ text: sql, rowMode: 'array' });
    const durationMs = Date.now() - started;
    const columns: SqlColumn[] = (res.fields ?? []).map((f) => ({ name: f.name }));
    const allRows = (res.rows ?? []) as unknown[][];
    const truncated = allRows.length > MAX_ROWS;
    const rows = (truncated ? allRows.slice(0, MAX_ROWS) : allRows).map((r) =>
      r.map(cell),
    );
    return {
      ok: true,
      columns,
      rows,
      rowCount: typeof res.rowCount === 'number' ? res.rowCount : null,
      command: res.command ?? null,
      truncated,
      durationMs,
    };
  } catch (err) {
    return {
      ok: false,
      ...empty,
      durationMs: Date.now() - started,
      error: friendlyError(err),
    };
  }
}

export async function sqlDisconnect(id: string): Promise<void> {
  const pool = pools.get(id);
  if (!pool) return;
  pools.delete(id);
  await pool.end().catch(() => {});
}

// End every live pool — called on app quit so connections close cleanly.
export async function sqlDisconnectAll(): Promise<void> {
  const all = Array.from(pools.values());
  pools.clear();
  await Promise.all(all.map((p) => p.end().catch(() => {})));
}
