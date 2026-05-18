import { useEffect, useRef, useState } from 'react';
import type { DirEntry, DirListing } from '@shared/types';

// A selected entry plus the directory it was picked from. `dir` is the
// containing folder — for a file selection it's the cwd to lock to;
// for a folder selection `path` itself is the cwd.
export interface PathSelection {
  path: string;
  isDirectory: boolean;
  dir: string;
}

interface PathPickerProps {
  // Directory to start browsing in. null → the user's home directory.
  initialPath: string | null;
  // Called when the user locks the conversation to a folder or file.
  onPick: (selection: PathSelection) => void;
}

// The browse/search popup behind the input's folder-icon button. Renders
// as a panel floating above the button (the Input wraps it and owns
// open/close + click-outside). Each browse step round-trips to the main
// process via window.api.listDir — the renderer has no fs access.
//
// Interaction (matches a normal file browser):
//   - Tapping a FOLDER row drills into it. Browse as deep as you like.
//   - Tapping a FILE row locks the conversation to that file.
//   - "Lock folder" locks the conversation to wherever you've navigated.
//   - The up-arrow goes to the parent; search filters the current folder.
export function PathPicker({ initialPath, onPick }: PathPickerProps) {
  // The directory currently being browsed. '' means "home" — listDir
  // resolves an empty path to the home directory.
  const [path, setPath] = useState<string>(initialPath ?? '');
  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // (Re)load the listing whenever the browsed directory changes. The
  // search filter resets on navigation so a stale query doesn't hide a
  // freshly-opened folder's contents.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setQuery('');
    window.api.listDir(path).then((result) => {
      if (cancelled) return;
      setListing(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [path]);

  // Focus the search field on mount so the user can type immediately.
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const entries = listing?.entries ?? [];
  const filtered = query
    ? entries.filter((e) => e.name.toLowerCase().includes(query.toLowerCase()))
    : entries;

  const parent = listing?.parent ?? null;
  // The directory currently shown — what "Lock folder" locks to. Null
  // only before the first listing resolves or on a load error.
  const currentDir = listing && !listing.error ? listing.path : null;

  return (
    <div className="absolute bottom-full left-0 mb-2 w-[360px] overflow-hidden rounded-xl border-[0.5px] border-[rgba(0,0,0,0.08)] bg-card shadow-popover">
      {/* Path bar: up-arrow, current path, lock-this-folder button. */}
      <div className="flex items-center gap-2 border-b-[0.5px] border-hairline px-3 py-2">
        <button
          type="button"
          onClick={() => parent !== null && setPath(parent)}
          disabled={parent === null}
          aria-label="Back to parent folder"
          className="flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-ink-label hover:bg-surface-subtle hover:text-ink disabled:opacity-30 disabled:hover:bg-transparent focus:outline-none"
        >
          <BackGlyph />
          <span>Back</span>
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-hint">
          {listing?.path ?? path}
        </span>
        <button
          type="button"
          onClick={() =>
            currentDir !== null &&
            onPick({ path: currentDir, isDirectory: true, dir: currentDir })
          }
          disabled={currentDir === null}
          className="shrink-0 rounded-md bg-ink px-2.5 py-1 text-[11px] font-medium text-card hover:bg-black disabled:opacity-30 disabled:hover:bg-ink focus:outline-none"
        >
          Lock folder
        </button>
      </div>

      {/* Search */}
      <div className="border-b-[0.5px] border-hairline px-3 py-2">
        <input
          ref={searchRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search this folder…"
          className="w-full bg-transparent text-[13px] text-ink placeholder:text-ink-hint focus:outline-none"
        />
      </div>

      {/* Entry list */}
      <div className="max-h-[280px] overflow-y-auto py-1">
        {loading && (
          <div className="px-3 py-2 text-[12px] text-ink-hint">Loading…</div>
        )}
        {!loading && listing?.error && (
          <div className="px-3 py-2 text-[12px] text-ink-label">{listing.error}</div>
        )}
        {!loading && !listing?.error && filtered.length === 0 && (
          <div className="px-3 py-2 text-[12px] text-ink-hint">
            {query ? 'No matches' : 'Empty folder'}
          </div>
        )}
        {!loading &&
          filtered.map((entry) => (
            <Row
              key={entry.path}
              entry={entry}
              onActivate={() => {
                if (entry.isDirectory) {
                  // Drill in — navigate, don't lock.
                  setPath(entry.path);
                } else {
                  // Files are terminal: lock the conversation to the file.
                  onPick({
                    path: entry.path,
                    isDirectory: false,
                    dir: listing?.path ?? path,
                  });
                }
              }}
            />
          ))}
      </div>
    </div>
  );
}

// One entry row. The whole row is the click target: folders drill in,
// files lock. The chevron on folders is a non-interactive affordance
// signalling "this opens."
function Row({ entry, onActivate }: { entry: DirEntry; onActivate: () => void }) {
  return (
    <button
      type="button"
      onClick={onActivate}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-subtle focus:outline-none"
    >
      {entry.isDirectory ? <FolderGlyph /> : <FileGlyph />}
      <span className="min-w-0 flex-1 truncate text-[13px] text-ink">
        {entry.name}
      </span>
      {entry.isDirectory && (
        <span className="shrink-0 text-ink-micro">
          <ChevronGlyph />
        </span>
      )}
    </button>
  );
}

function BackGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <line x1="2.5" y1="6" x2="9.5" y2="6" />
      <polyline points="5.5,2.5 2,6 5.5,9.5" />
    </svg>
  );
}

function ChevronGlyph() {
  return (
    <svg
      viewBox="0 0 12 12"
      className="h-3 w-3"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="4,2 8,6 4,10" />
    </svg>
  );
}

function FolderGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0 text-ink-label"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 3.5h3.5l1.2 1.5h6.3v5.5a1 1 0 0 1-1 1H2.5a1 1 0 0 1-1-1z" />
    </svg>
  );
}

function FileGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5 shrink-0 text-ink-hint"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 1.5h5l3 3v8a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1z" />
      <polyline points="8.5,1.5 8.5,4.5 11.5,4.5" />
    </svg>
  );
}
