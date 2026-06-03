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

  return (
    <div className="absolute bottom-full left-0 mb-2 w-[360px] overflow-hidden rounded-xl border-[0.5px] border-[rgba(0,0,0,0.08)] bg-card shadow-popover">
      {/* Path bar: back, home, and the current path. */}
      <div className="flex items-center gap-1.5 border-b-[0.5px] border-hairline px-2.5 py-2">
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
        <button
          type="button"
          onClick={() => setPath('')}
          aria-label="Home folder"
          title="Home folder"
          className="flex shrink-0 items-center justify-center rounded px-1.5 py-1 text-ink-label hover:bg-surface-subtle hover:text-ink focus:outline-none"
        >
          <HomeGlyph />
        </button>
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-hint">
          {listing?.path ?? path}
        </span>
      </div>

      {/* Search */}
      <div className="border-b-[0.5px] border-hairline p-2">
        <div className="relative">
          <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-hint">
            <SearchGlyph />
          </span>
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search this folder…"
            className="w-full rounded-lg border border-hairline bg-surface-subtle py-1.5 pl-8 pr-2.5 text-[13px] text-ink placeholder:text-ink-hint focus:border-ink/20 focus:bg-card focus:outline-none"
          />
        </div>
      </div>

      {/* Entry list */}
      <div className="max-h-[280px] overflow-y-auto p-1">
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
              onSelect={() => {
                if (entry.isDirectory) {
                  // Clicking a folder's NAME cd's into it (locks to it).
                  onPick({ path: entry.path, isDirectory: true, dir: entry.path });
                } else {
                  // Files are terminal: lock the conversation to the file.
                  onPick({
                    path: entry.path,
                    isDirectory: false,
                    dir: listing?.path ?? path,
                  });
                }
              }}
              // The "Inside" button drills in to browse the folder's contents.
              onEnter={() => setPath(entry.path)}
            />
          ))}
      </div>
    </div>
  );
}

// One entry row.
//  - Folder: clicking the NAME cd's into that folder (locks to it); the
//    trailing "Inside" button drills in to browse its contents instead.
//  - File: clicking locks the conversation to that file.
function Row({
  entry,
  onSelect,
  onEnter,
}: {
  entry: DirEntry;
  onSelect: () => void;
  onEnter: () => void;
}) {
  if (!entry.isDirectory) {
    return (
      <button
        type="button"
        onClick={onSelect}
        className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-surface-subtle focus:outline-none"
      >
        <FileGlyph />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.name}</span>
      </button>
    );
  }
  return (
    <div className="group flex items-center gap-1 rounded-lg pr-1 hover:bg-surface-subtle">
      <button
        type="button"
        onClick={onSelect}
        title={`Use ${entry.name}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 py-2 text-left focus:outline-none"
      >
        <FolderGlyph />
        <span className="min-w-0 flex-1 truncate text-[13px] text-ink">{entry.name}</span>
      </button>
      <button
        type="button"
        onClick={onEnter}
        aria-label={`Open ${entry.name}`}
        title="Browse inside this folder"
        className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium text-ink-micro transition-colors hover:bg-black/[0.06] hover:text-ink focus:outline-none focus-visible:bg-black/[0.06] focus-visible:text-ink"
      >
        Inside
        <ChevronGlyph />
      </button>
    </div>
  );
}

function SearchGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="6" cy="6" r="4" />
      <line x1="9" y1="9" x2="12.5" y2="12.5" />
    </svg>
  );
}

function HomeGlyph() {
  return (
    <svg
      viewBox="0 0 14 14"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 6.5 7 2.5l5 4" />
      <path d="M3.2 5.8V11a1 1 0 0 0 1 1h5.6a1 1 0 0 0 1-1V5.8" />
    </svg>
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
