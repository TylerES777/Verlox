import { useCallback, useEffect, useRef, useState } from 'react';
import type { SqlConnectConfig, SqlQueryResult } from '@shared/types';

interface SqlConsoleViewProps {
  // The owning tab's id — doubles as the connection key in main.
  id: string;
}

// Statements that change data or schema. A leading match gates the run behind
// an explicit approval — Verlox's safe-CLI angle, applied to SQL.
const DESTRUCTIVE_RE =
  /^(insert|update|delete|drop|alter|truncate|create|grant|revoke|replace|merge|reindex|vacuum|comment)\b/i;

function isDestructive(sql: string): boolean {
  return sql
    .split(';')
    .map((s) =>
      s
        .replace(/--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .trim(),
    )
    .filter(Boolean)
    .some((stmt) => DESTRUCTIVE_RE.test(stmt));
}

// A SQL console tab. Connect to a Postgres database, then run SQL directly and
// see the results as a table. Main owns the connection (see sql-manager.ts);
// this view drives it. The plain-English agent layer can sit on top later —
// this is the raw, interactive surface.
export function SqlConsoleView({ id }: SqlConsoleViewProps) {
  const [status, setStatus] = useState<'disconnected' | 'connecting' | 'connected'>(
    'disconnected',
  );
  const [form, setForm] = useState<SqlConnectConfig>({
    host: 'localhost',
    port: 5432,
    database: '',
    user: 'postgres',
    password: '',
    ssl: false,
  });
  const [serverVersion, setServerVersion] = useState<string | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  const [sql, setSql] = useState('');
  const [result, setResult] = useState<SqlQueryResult | null>(null);
  const [running, setRunning] = useState(false);
  const [confirmDestructive, setConfirmDestructive] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // When the destructive-approval card appears, focus Cancel so an accidental
  // Enter is safe (never destructive by default).
  useEffect(() => {
    if (confirmDestructive) cancelRef.current?.focus();
  }, [confirmDestructive]);

  const connect = useCallback(async () => {
    setStatus('connecting');
    setConnectError(null);
    const res = await window.api.sqlConnect(id, form);
    if (res.ok) {
      setServerVersion(res.serverVersion ?? null);
      setStatus('connected');
    } else {
      setConnectError(res.error ?? 'Could not connect.');
      setStatus('disconnected');
    }
  }, [id, form]);

  const disconnect = useCallback(async () => {
    await window.api.sqlDisconnect(id);
    setStatus('disconnected');
    setResult(null);
    setServerVersion(null);
  }, [id]);

  const runNow = useCallback(
    async (text: string) => {
      setRunning(true);
      setConfirmDestructive(false);
      const res = await window.api.sqlQuery(id, text);
      setResult(res);
      setRunning(false);
    },
    [id],
  );

  const run = useCallback(() => {
    const text = sql.trim();
    if (!text || running) return;
    if (isDestructive(text)) {
      setConfirmDestructive(true);
      return;
    }
    void runNow(text);
  }, [sql, running, runNow]);

  const onEditorKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        run();
      }
    },
    [run],
  );

  const setField = useCallback(
    <K extends keyof SqlConnectConfig>(key: K, value: SqlConnectConfig[K]) => {
      setForm((f) => ({ ...f, [key]: value }));
    },
    [],
  );

  // --- Disconnected: connection form ---------------------------------------
  if (status !== 'connected') {
    const connecting = status === 'connecting';
    return (
      <div className="flex h-full w-full items-center justify-center overflow-y-auto p-6">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!connecting) void connect();
          }}
          className="w-full max-w-sm rounded-xl border border-hairline bg-surface-faint p-5"
        >
          <div className="mb-1 text-sm font-medium text-ink">Connect a database</div>
          <p className="mb-4 text-[12px] leading-relaxed text-ink-hint">
            Postgres for now. Your password is sent once to open the connection
            and isn't kept in the window.
          </p>

          <div className="grid grid-cols-3 gap-2">
            <Field className="col-span-2" label="Host">
              <input
                className={inputCls}
                value={form.host}
                onChange={(e) => setField('host', e.target.value)}
                placeholder="localhost"
              />
            </Field>
            <Field label="Port">
              <input
                className={inputCls}
                type="number"
                value={form.port}
                onChange={(e) => setField('port', Number(e.target.value) || 0)}
              />
            </Field>
          </div>

          <Field label="Database">
            <input
              className={inputCls}
              value={form.database}
              onChange={(e) => setField('database', e.target.value)}
              placeholder="postgres"
            />
          </Field>

          <div className="grid grid-cols-2 gap-2">
            <Field label="User">
              <input
                className={inputCls}
                value={form.user}
                onChange={(e) => setField('user', e.target.value)}
              />
            </Field>
            <Field label="Password">
              <input
                className={inputCls}
                type="password"
                value={form.password}
                onChange={(e) => setField('password', e.target.value)}
              />
            </Field>
          </div>

          <label className="mt-3 flex cursor-pointer items-center gap-2 text-[12px] text-ink-label">
            <input
              type="checkbox"
              checked={form.ssl}
              onChange={(e) => setField('ssl', e.target.checked)}
            />
            Use SSL (needed for most hosted databases)
          </label>

          {connectError && (
            <div className="mt-3 text-[12px] leading-relaxed text-[#B4632F]">
              {connectError}
            </div>
          )}

          <button
            type="submit"
            disabled={connecting || !form.host || !form.database}
            className="mt-4 w-full rounded-lg bg-[#3A3A3A] px-3 py-2 text-[13px] font-medium text-white hover:bg-black disabled:opacity-50"
          >
            {connecting ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    );
  }

  // --- Connected: editor + results -----------------------------------------
  return (
    <div className="flex h-full w-full flex-col">
      {/* Connection header */}
      <div className="flex shrink-0 items-center justify-between border-b border-hairline px-3 py-2">
        <div className="min-w-0">
          <span className="text-[12.5px] font-medium text-ink">{form.database}</span>
          <span className="ml-2 text-[11px] text-ink-hint">
            {form.user}@{form.host}
            {serverVersion ? ` · ${serverVersion}` : ''}
          </span>
        </div>
        <button
          onClick={() => void disconnect()}
          className="rounded-md border border-hairline px-2 py-0.5 text-[11.5px] text-ink-label hover:bg-black/5 hover:text-ink"
        >
          Disconnect
        </button>
      </div>

      {/* Editor */}
      <div className="shrink-0 border-b border-hairline p-3">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={onEditorKeyDown}
          spellCheck={false}
          placeholder="SELECT * FROM users ORDER BY created_at DESC LIMIT 50;"
          className="h-28 w-full resize-y rounded-lg border border-hairline bg-card p-2.5 font-mono text-[12.5px] leading-relaxed text-ink placeholder:text-ink-hint focus:border-ink/20 focus:outline-none"
        />
        {confirmDestructive ? (
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-[#E8C36B]/50 bg-[#FBF6E9] px-3 py-2">
            <span className="flex-1 text-[12px] text-[#7A5B1E]">
              This statement changes data or schema. Run it?
            </span>
            <button
              ref={cancelRef}
              onClick={() => setConfirmDestructive(false)}
              className="rounded-md px-2 py-1 text-[12px] text-ink-label hover:text-ink"
            >
              Cancel
            </button>
            <button
              onClick={() => void runNow(sql.trim())}
              className="rounded-md bg-[#B4632F] px-2.5 py-1 text-[12px] font-medium text-white hover:bg-[#9c5128]"
            >
              Run anyway
            </button>
          </div>
        ) : (
          <div className="mt-2 flex items-center gap-3">
            <button
              onClick={run}
              disabled={running || !sql.trim()}
              className="rounded-lg bg-[#3A3A3A] px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-black disabled:opacity-50"
            >
              {running ? 'Running…' : 'Run'}
            </button>
            <span className="text-[11px] text-ink-hint">⌘/Ctrl + Enter</span>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!result ? (
          <div className="p-4 text-[12px] text-ink-hint">
            Run a query to see results here.
          </div>
        ) : !result.ok ? (
          <div className="p-4 text-[12.5px] leading-relaxed text-[#B4632F]">
            {result.error}
          </div>
        ) : result.columns.length === 0 ? (
          <div className="p-4 text-[12.5px] text-ink-label">
            {result.command ?? 'Done'}
            {result.rowCount != null
              ? ` · ${result.rowCount} row${result.rowCount === 1 ? '' : 's'} affected`
              : ''}
            {` · ${result.durationMs} ms`}
          </div>
        ) : (
          <ResultTable result={result} />
        )}
      </div>
    </div>
  );
}

function ResultTable({ result }: { result: SqlQueryResult }) {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full border-collapse text-left font-mono text-[12px]">
          <thead className="sticky top-0 z-10 bg-surface-subtle">
            <tr>
              <th className="border-b border-hairline px-2 py-1.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-micro">
                #
              </th>
              {result.columns.map((c, i) => (
                <th
                  key={`${c.name}-${i}`}
                  className="whitespace-nowrap border-b border-l border-hairline px-2.5 py-1.5 text-[11px] font-semibold text-ink-label"
                >
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr key={ri} className="hover:bg-black/[0.02]">
                <td className="border-b border-hairline px-2 py-1 text-[10.5px] text-ink-micro">
                  {ri + 1}
                </td>
                {row.map((value, ci) => (
                  <td
                    key={ci}
                    className="max-w-[360px] truncate border-b border-l border-hairline px-2.5 py-1 text-ink"
                    title={value ?? 'NULL'}
                  >
                    {value === null ? (
                      <span className="italic text-ink-micro">NULL</span>
                    ) : (
                      value
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="shrink-0 border-t border-hairline px-3 py-1.5 text-[11px] text-ink-hint">
        {result.rowCount ?? result.rows.length} row
        {(result.rowCount ?? result.rows.length) === 1 ? '' : 's'}
        {result.truncated ? ` · showing first ${result.rows.length}` : ''}
        {` · ${result.durationMs} ms`}
      </div>
    </div>
  );
}

const inputCls =
  'w-full rounded-lg border border-hairline bg-card px-2 py-1.5 text-[12.5px] text-ink placeholder:text-ink-hint focus:border-ink/20 focus:outline-none';

function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`mt-3 block ${className ?? ''}`}>
      <span className="mb-1 block text-[11px] font-medium text-ink-label">{label}</span>
      {children}
    </label>
  );
}
