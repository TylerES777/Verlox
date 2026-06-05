import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ConversationTab } from './TabBar';
import { finalizeProcess, useRunningProcesses } from '../hooks/useRunningProcesses';
import { readTerminalText } from '../lib/terminalRegistry';
import { useAuth } from '../contexts/AuthContext';
import { useUsage } from '../contexts/UsageContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { useUpdateStatus } from '../hooks/useUpdateStatus';

interface SidebarProps {
  tabs: ConversationTab[];
  activeId: string;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}

// Left sidebar. Four stacked sections: a search box, the open tabs, the
// Rewind timeline (restore points the app makes on its own — no folder to
// pick), and the live-running processes. The terminal sits as a centered
// board to the right (see ConversationsShell). The new-terminal button lives
// at the top of the board area, not here.
export function Sidebar({ tabs, activeId, onSelect, onClose }: SidebarProps) {
  const [query, setQuery] = useState('');
  // Hover-preview card for a tab: shows that terminal's recent output.
  const [preview, setPreview] = useState<{
    title: string;
    top: number;
    left: number;
    text: string;
  } | null>(null);
  const q = query.trim().toLowerCase();
  const visibleTabs = q
    ? tabs.filter((t) => t.title.toLowerCase().includes(q))
    : tabs;

  return (
    <>
    <aside className="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden rounded-xl border border-hairline bg-surface-faint shadow-sm">
      {/* Brand */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="text-base leading-none text-ink-label" aria-hidden="true">
          ✦
        </span>
        <span className="text-sm font-medium tracking-tight text-ink">Verlox</span>
      </div>

      {/* Search */}
      <div className="px-3 pb-3">
        <div className="relative">
          <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-hint">
            <SearchGlyph />
          </span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tabs…"
            className="w-full rounded-lg border border-hairline bg-card py-1.5 pl-7 pr-2 text-[12.5px] text-ink placeholder:text-ink-hint focus:border-ink/20 focus:outline-none"
          />
        </div>
      </div>

      {/* Tabs */}
      <div className="px-2">
        <SectionLabel>Tabs</SectionLabel>
        <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto">
          {/* Newest at the top, oldest below. */}
          {[...visibleTabs].reverse().map((tab) => {
            const active = tab.id === activeId;
            return (
              <li key={tab.id}>
                <div
                  onClick={() => onSelect(tab.id)}
                  onMouseEnter={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setPreview({
                      title: tab.title,
                      top: Math.min(r.top, window.innerHeight - 332),
                      left: r.right + 10,
                      text: readTerminalText(tab.id, 80),
                    });
                  }}
                  onMouseLeave={() => setPreview(null)}
                  className={`group flex cursor-default items-center gap-2 rounded-lg px-2 py-1.5 text-[12.5px] ${
                    active
                      ? 'bg-card text-ink shadow-[0_1px_2px_rgba(0,0,0,0.05)]'
                      : 'text-ink-label hover:bg-black/[0.04] hover:text-ink'
                  }`}
                >
                  {tab.kind === 'sql' ? <SqlGlyph /> : <TerminalGlyph />}
                  <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onClose(tab.id);
                    }}
                    aria-label="Close tab"
                    className={`flex h-4 w-4 items-center justify-center rounded text-ink-micro hover:text-ink ${
                      active ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                    }`}
                  >
                    <CloseGlyph />
                  </button>
                </div>
              </li>
            );
          })}
          {visibleTabs.length === 0 && (
            <li className="px-2 py-1 text-[11.5px] text-ink-hint">No tabs match.</li>
          )}
        </ul>
      </div>

      <Divider />

      {/* Live running processes. */}
      <RunningSection onSelect={onSelect} />

      {/* Account — email, usage/plan, change plan, log out. Pinned bottom. */}
      <ProfileSection />
    </aside>
    {preview &&
      createPortal(
        <div
          style={{
            position: 'fixed',
            left: preview.left,
            top: preview.top,
            zIndex: 100,
          }}
          className="pointer-events-none w-[440px] overflow-hidden rounded-xl border border-hairline bg-card p-3 shadow-xl"
        >
          <div className="mb-1.5 truncate text-[11px] font-medium text-ink-label">
            {preview.title}
          </div>
          <pre className="max-h-[280px] overflow-hidden whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink">
            {preview.text || 'No output yet.'}
          </pre>
        </div>,
        document.body,
      )}
    </>
  );
}
// --- Running ---------------------------------------------------------------

function RunningSection({ onSelect }: { onSelect: (id: string) => void }) {
  const procs = useRunningProcesses();
  const live = procs.filter((p) => p.status === 'running');

  return (
    <div className="shrink-0 px-2 pb-3 pt-1">
      <div className="flex items-center gap-1.5 px-2">
        <SectionLabel>Running</SectionLabel>
        {live.length > 0 && (
          <span className="rounded-full bg-[#EAF3ED] px-1.5 text-[10px] font-medium text-[#3E7A53]">
            {live.length}
          </span>
        )}
      </div>

      {live.length === 0 ? (
        <p className="px-2 py-2 text-[11.5px] text-ink-hint">Nothing running.</p>
      ) : (
        <ul className="mt-1 max-h-44 space-y-0.5 overflow-y-auto">
          {live.map((p) => (
            <li key={p.stepId}>
              <div className="flex items-center gap-1.5 rounded-md px-2 py-1.5 hover:bg-black/[0.04]">
                <button
                  type="button"
                  onClick={() =>
                    p.detectedUrl
                      ? window.api.openExternal(p.detectedUrl as string)
                      : onSelect(p.conversationId)
                  }
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={p.detectedUrl ? `Open ${p.detectedUrl}` : p.command}
                >
                  <GlobeGlyph />
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-ink">
                    {p.command}
                  </span>
                </button>
                {/* Where it came from: a command Verlox ran vs one you typed. */}
                <span
                  title={
                    p.source === 'terminal'
                      ? 'You started this in the terminal'
                      : 'Verlox started this'
                  }
                  className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                    p.source === 'terminal'
                      ? 'bg-black/[0.06] text-ink-hint'
                      : 'bg-[#EAF3ED] text-[#3E7A53]'
                  }`}
                >
                  {p.source === 'terminal' ? 'You' : 'Verlox'}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    if (p.source === 'terminal') {
                      // Send Ctrl+C to that terminal's shell, and clear the row
                      // now — the prompt-return detector only runs while that
                      // terminal is on screen, so don't depend on it.
                      window.api.ptyInput({ id: p.conversationId, data: '\x03' });
                      finalizeProcess(p.stepId, { exitCode: 0, signal: 'SIGINT' });
                    } else {
                      window.api.stopCommand(p.stepId);
                    }
                  }}
                  aria-label="Stop"
                  title={p.source === 'terminal' ? 'Stop (Ctrl+C)' : 'Stop'}
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-ink-label transition-colors hover:bg-[#FBF1EA] hover:text-[#B4632F]"
                >
                  <StopGlyph />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// --- Profile / account -----------------------------------------------------

function ProfileSection() {
  const { user, signOut } = useAuth();
  const { usage, openUsage } = useUsage();
  const { openUpgrade } = useUpgrade();
  const update = useUpdateStatus();
  const [open, setOpen] = useState(false);
  const [version, setVersion] = useState('');
  useEffect(() => {
    void window.api.getAppVersion().then(setVersion).catch(() => {});
  }, []);

  const email = user?.email ?? 'Signed in';
  const initial = (user?.email?.charAt(0) ?? '?').toUpperCase();
  const tier = usage?.tier === 'pro' ? 'Pro' : 'Free';
  const usedPct = usage
    ? Math.min(100, Math.round((usage.used / Math.max(1, usage.limit)) * 100))
    : 0;

  return (
    <div className="relative mt-auto shrink-0 border-t border-hairline p-2">
      {open && (
        <>
          {/* Click-catcher to close the menu. */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-2 right-2 z-50 mb-1 overflow-hidden rounded-xl border border-hairline bg-card p-1 shadow-xl">
            <div className="px-2.5 pb-1.5 pt-2">
              <div className="truncate text-[12px] font-medium text-ink" title={email}>
                {email}
              </div>
              <div className="mt-0.5 text-[10.5px] text-ink-hint">{tier} plan</div>
            </div>
            {usage && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  openUsage();
                }}
                className="w-full rounded-lg px-2.5 py-1.5 text-left hover:bg-black/[0.04]"
              >
                <div className="flex items-center justify-between text-[11px] text-ink-label">
                  <span>Usage</span>
                  <span className="text-ink-hint">
                    {usage.remaining}/{usage.limit} left
                  </span>
                </div>
                <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-black/[0.07]">
                  <div
                    className="h-full rounded-full bg-[#3E7A53]"
                    style={{ width: `${usedPct}%` }}
                  />
                </div>
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                openUpgrade();
              }}
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-ink-label hover:bg-black/[0.04] hover:text-ink"
            >
              Change plan
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                void signOut();
              }}
              className="w-full rounded-lg px-2.5 py-1.5 text-left text-[12px] text-[#B4632F] hover:bg-[#FBF1EA]"
            >
              Log out
            </button>
            {/* Update affordance — appears once a new version has downloaded
                in the background. Otherwise just shows the current version. */}
            {update.state === 'downloaded' ? (
              <button
                type="button"
                onClick={() => window.api.installUpdate()}
                className="mt-1 w-full rounded-lg bg-[#EAF3ED] px-2.5 py-1.5 text-left text-[12px] font-medium text-[#3E7A53] hover:bg-[#DCEEDF]"
              >
                Restart to update{update.version ? ` · v${update.version}` : ''}
              </button>
            ) : update.state === 'downloading' ? (
              <div className="px-2.5 py-1.5 text-[11px] text-ink-hint">
                Downloading update…
                {update.percent != null ? ` ${update.percent}%` : ''}
              </div>
            ) : null}
            <div className="mt-1 border-t border-hairline px-2.5 pb-1 pt-1.5 text-[10px] text-ink-micro">
              Verlox v{version || '—'}
            </div>
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-black/[0.04]"
      >
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#3A3A3A] text-[11px] font-semibold text-white">
          {initial}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[12px] text-ink">{email}</span>
          <span className="block text-[10px] text-ink-hint">
            {tier}
            {usage ? ` · ${usage.remaining}/${usage.limit} left` : ''}
          </span>
        </span>
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5 shrink-0 text-ink-hint"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
        >
          <path d="M4 10l4-4 4 4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>
  );
}

// --- small shared bits -----------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="px-2 text-[10.5px] font-medium uppercase tracking-wider text-ink-micro">
      {children}
    </span>
  );
}

function Divider() {
  return <div className="mx-3 my-2 border-t border-hairline" />;
}

function GlobeGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 shrink-0 text-[#3E7A53]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <ellipse cx="8" cy="8" rx="2.6" ry="6" />
      <line x1="2" y1="8" x2="14" y2="8" />
    </svg>
  );
}

function StopGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3 shrink-0" fill="currentColor" aria-hidden="true">
      <rect x="3.5" y="3.5" width="9" height="9" rx="1.6" />
    </svg>
  );
}

// --- glyphs ----------------------------------------------------------------

function SearchGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <circle cx="6" cy="6" r="4" />
      <line x1="9" y1="9" x2="12.5" y2="12.5" />
    </svg>
  );
}

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="2.5" width="12" height="9" rx="1.5" />
      <path d="M3.5 5.5L6 7l-2.5 1.5" />
      <line x1="7.5" y1="8.5" x2="10" y2="8.5" />
    </svg>
  );
}

function SqlGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="7" cy="3.2" rx="4.5" ry="1.8" />
      <path d="M2.5 3.2v7.6c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8V3.2" />
      <path d="M2.5 7c0 1 2 1.8 4.5 1.8s4.5-.8 4.5-1.8" />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg viewBox="0 0 10 10" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      <line x1="1.5" y1="1.5" x2="8.5" y2="8.5" />
      <line x1="8.5" y1="1.5" x2="1.5" y2="8.5" />
    </svg>
  );
}
