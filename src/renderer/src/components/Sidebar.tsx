import { useEffect, useState } from 'react';
import { finalizeProcess, useRunningProcesses } from '../hooks/useRunningProcesses';
import { useAuth } from '../contexts/AuthContext';
import { useUsage } from '../contexts/UsageContext';
import { useUpgrade } from '../contexts/UpgradeContext';
import { useUpdateStatus } from '../hooks/useUpdateStatus';
import { VaultGlyph } from './VaultView';
import { ClockGlyph } from './TimelineView';
import type { AppView } from './ConversationsShell';
import verloxIcon from '../assets/verlox-icon.svg';

interface SidebarProps {
  // Which surface is showing in the main area; drives the nav highlight.
  activeView: AppView;
  onNavigate: (view: AppView) => void;
  onToggleSidebar: () => void;
}

// Left sidebar: brand row (drag handle + collapse), the app navigation
// (Terminal / Settings / Recovery Vault / Timeline as labeled rows, each a
// real page in the main area), live running processes, and the account
// section pinned at the bottom. Tabs live only in the top tab bar now.
export function Sidebar({ activeView, onNavigate, onToggleSidebar }: SidebarProps) {
  return (
    <aside
      className="flex min-h-0 w-64 shrink-0 flex-col overflow-hidden"
      style={{
        background: 'linear-gradient(180deg, #f6f7fb 0%, #eef0f7 100%)',
        boxShadow: 'inset -1px 0 0 rgba(255,255,255,0.7), 1px 0 0 rgba(0,0,0,0.06)',
      }}
    >
      {/* Brand row — also the window drag handle on the sidebar side, with
          the app controls (collapse, settings, vault, timeline) at its right
          in the sidebar's own theme. */}
      <div
        className="flex items-center justify-between px-4 pb-4 pt-4"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <img
          src={verloxIcon}
          alt="Verlox"
          className="h-7 w-7 rounded-lg"
          draggable={false}
        />
        <button
          type="button"
          onClick={onToggleSidebar}
          aria-label="Hide sidebar"
          title="Hide sidebar"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-ink-label transition-colors hover:bg-black/[0.06] hover:text-ink"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <svg
            viewBox="0 0 16 16"
            className="h-[18px] w-[18px]"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="2.25" y="3.25" width="11.5" height="9.5" rx="2" />
            <line x1="6.5" y1="3.5" x2="6.5" y2="12.5" />
          </svg>
        </button>
      </div>

      {/* App navigation — each row is a page in the main area. */}
      <nav className="px-3 pt-1">
        <ul className="space-y-1">
          <NavRow
            label="Terminal"
            active={activeView === 'terminal'}
            onClick={() => onNavigate('terminal')}
            icon={<TerminalGlyph />}
          />
          <NavRow
            label="Settings"
            active={activeView === 'settings'}
            onClick={() => onNavigate('settings')}
            icon={<GearGlyph />}
          />
          <NavRow
            label="Recovery Vault"
            active={activeView === 'vault'}
            onClick={() => onNavigate('vault')}
            icon={<VaultGlyph className="h-3.5 w-3.5" />}
          />
          <NavRow
            label="Timeline"
            active={activeView === 'timeline'}
            onClick={() => onNavigate('timeline')}
            icon={<ClockGlyph className="h-3.5 w-3.5" />}
          />
        </ul>
      </nav>

      <Divider />

      {/* Live running processes. */}
      <RunningSection />

      {/* Upgrade pill — Perplexity-style, centered above the account row.
          Free users only; Pro has nothing to upgrade to. */}
      <UpgradeBar />

      {/* Account — email, usage/plan, change plan, log out. Pinned bottom. */}
      <ProfileSection />
    </aside>
  );
}

function UpgradeBar() {
  const { usage } = useUsage();
  const { openUpgrade } = useUpgrade();
  if (usage?.tier === 'pro') return null;
  return (
    <div className="mt-auto flex shrink-0 justify-center px-3 pb-2 pt-2">
      <button
        type="button"
        onClick={() => openUpgrade()}
        className="flex items-center gap-1.5 rounded-full border border-black/[0.08] bg-white/70 px-3.5 py-1.5 text-[12px] font-medium text-ink-label transition-colors hover:bg-white hover:text-ink"
      >
        <svg
          viewBox="0 0 16 16"
          className="h-3.5 w-3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="6.25" />
          <path d="M8 5v6M5 8h6" />
        </svg>
        Upgrade plan
      </button>
    </div>
  );
}

// Perplexity-style nav row: comfortable height, larger icon + label, and the
// SAME soft tint for hover and selection (a touch stronger when active) — no
// white card, no shadow.
function NavRow({
  label,
  active,
  onClick,
  icon,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[13.5px] transition-colors [&_svg]:h-[18px] [&_svg]:w-[18px] ${
          active
            ? 'bg-black/[0.06] font-medium text-ink'
            : 'text-ink-label hover:bg-black/[0.04] hover:text-ink'
        }`}
      >
        <span
          className={`flex w-5 shrink-0 items-center justify-center ${
            active ? 'text-ink' : 'text-ink-hint'
          }`}
        >
          {icon}
        </span>
        {label}
      </button>
    </li>
  );
}

function GearGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}
// --- Running ---------------------------------------------------------------

function RunningSection() {
  const procs = useRunningProcesses();
  const live = procs.filter((p) => p.status === 'running');
  // Jump to the tab a process runs in. The sidebar no longer owns tab state,
  // so this asks the shell to switch via an event.
  const onSelect = (id: string) =>
    window.dispatchEvent(new CustomEvent('verlox:select-tab', { detail: { id } }));

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

function TerminalGlyph() {
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="1" y="2.5" width="12" height="9" rx="1.5" />
      <path d="M3.5 5.5L6 7l-2.5 1.5" />
      <line x1="7.5" y1="8.5" x2="10" y2="8.5" />
    </svg>
  );
}

