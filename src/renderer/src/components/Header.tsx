import { HeaderMenu } from './HeaderMenu';
import { PlanModeToggle } from './PlanModeToggle';
import { UpdateButton } from './UpdateButton';

interface HeaderProps {
  // The conversation's working-directory display path, or null when the
  // conversation is folderless (the user hasn't chosen a folder). null
  // renders a faint "No folder" — commands still run, from the home
  // directory, but the header is honest that no folder was picked.
  displayPath: string | null;
  // Session-wide Plan Mode (Chunk 4). Rendered as a header pill between
  // the cwd and the avatar.
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
  // Whether the Clear button is meaningful — false when there's nothing
  // to clear (empty conversation). The button hides entirely in that
  // case rather than dimming, so the header chrome stays minimal.
  canClear: boolean;
  // Drops the whole conversation: kills any running steps, cancels
  // synthesize streams, empties the message list.
  onClear: () => void;
}

// Per-conversation header. Three slots: wordmark | cwd | right-group.
// The wordmark, Plan Mode toggle, and account menu reflect app-global
// state — each conversation renders its own Header but only the active
// conversation's is on screen, and the session-wide props keep them all
// in sync. The cwd slot is the one genuinely per-conversation piece.
export function Header({
  displayPath,
  planMode,
  onPlanModeChange,
  canClear,
  onClear,
}: HeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b-[0.5px] border-hairline px-6">
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-mono text-[14px] font-medium tracking-tight text-ink">
          verlox
        </span>
        {/* DEV badge — only in dev builds (localhost backend). Amber
            pill so a dev window is unmistakable at a glance and never
            confused with the production app. */}
        {import.meta.env.DEV && (
          <span className="rounded-md border border-amber/40 bg-amber/[0.12] px-1.5 py-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.1em] text-amber">
            Dev
          </span>
        )}
      </div>
      {/* The locked path takes the whole middle. flex-1 + min-w-0 lets it
          use the full available width so the entire folder trace shows;
          truncate is only a last-resort guard on an extreme path. When
          there's no folder the middle is simply empty — no placeholder. */}
      {displayPath !== null ? (
        <span className="mx-4 min-w-0 flex-1 truncate text-center font-mono text-[12px] text-ink-hint">
          {displayPath}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      <div className="flex shrink-0 items-center gap-3">
        {/* Auto-update: self-managing — renders the Update button only
            when a new version is downloaded (and a progress pill while
            downloading), nothing otherwise. */}
        <UpdateButton />
        {canClear && <ClearButton onClick={onClear} />}
        <PlanModeToggle on={planMode} onChange={onPlanModeChange} />
        <HeaderMenu />
      </div>
    </header>
  );
}

// Clear-conversation button. Icon + label, styled to match the visual
// weight of PlanModeToggle so the right-group reads as a row of peer
// controls. The eraser glyph reads as "wipe this" more clearly than a
// trash can would — trash implies permanent deletion of an item, but
// clearing the terminal is a soft reset.
function ClearButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Clear conversation"
      aria-label="Clear conversation"
      className="flex h-7 items-center gap-1.5 rounded-md border-[0.5px] border-subtle-border bg-surface-faint px-2.5 text-[12px] text-ink-label transition-colors hover:bg-surface-subtle hover:text-ink focus:outline-none"
    >
      <EraserGlyph />
      <span>Clear</span>
    </button>
  );
}

function EraserGlyph() {
  // Reload — circular arrow with a single arrowhead. Reads as "reset
  // / start over" at 14px. Three-quarter arc so the gap clearly
  // signals direction.
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8a5 5 0 1 0 1.6-3.7" />
      <polyline points="3,2 3,5 6,5" />
    </svg>
  );
}
