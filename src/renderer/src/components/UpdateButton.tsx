import { useUpdateStatus } from '../hooks/useUpdateStatus';

// Auto-update affordance in the header. Three visible states:
//   downloaded  → a green "Update" button that installs on click and
//                 PERSISTS until the user does (the new version replaces
//                 the running one, after which status returns to idle and
//                 the button disappears). This is the state the user
//                 asked for: shows up and stays until installed.
//   downloading → a calm, non-clickable "Updating N%" pill so the user
//                 sees progress before the install is offered.
//   everything else (idle / checking / error) → nothing, to keep the
//                 header quiet when there's nothing to act on.
export function UpdateButton() {
  const { state, version, percent } = useUpdateStatus();

  if (state === 'downloaded') {
    return (
      <button
        type="button"
        onClick={() => window.api.installUpdate()}
        title={
          version
            ? `Restart to install Verlox ${version}`
            : 'Restart to install the update'
        }
        aria-label="Install update and restart"
        className="flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-white transition-transform focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/30 active:scale-[0.98]"
        style={{
          background: 'linear-gradient(180deg, #34B36B 0%, #1E8048 100%)',
          boxShadow:
            '0 1px 0 rgba(255,255,255,0.18) inset, 0 1px 2px rgba(16,80,40,0.25), 0 4px 12px -4px rgba(20,120,60,0.35)',
        }}
      >
        <DownloadGlyph />
        <span>Update</span>
      </button>
    );
  }

  if (state === 'downloading') {
    return (
      <span
        className="flex h-7 items-center gap-1.5 rounded-md border border-subtle-border bg-surface-faint px-2.5 text-[11.5px] text-ink-label"
        title="Downloading the latest version"
      >
        <Spinner />
        <span className="tabular-nums">
          Updating{percent !== null ? ` ${percent}%` : '…'}
        </span>
      </span>
    );
  }

  return null;
}

function DownloadGlyph() {
  // Down-arrow into a tray — the universal "download / install" mark.
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M8 2.5v7" />
      <polyline points="5,7 8,10 11,7" />
      <path d="M3 12.5h10" />
    </svg>
  );
}

function Spinner() {
  // Quarter-arc ring that rotates via the shared animate-spin utility.
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5 animate-spin"
      fill="none"
      aria-hidden="true"
    >
      <circle
        cx="8"
        cy="8"
        r="5.5"
        stroke="currentColor"
        strokeOpacity="0.25"
        strokeWidth="1.6"
      />
      <path
        d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}
