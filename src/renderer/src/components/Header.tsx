import { HeaderMenu } from './HeaderMenu';
import { PlanModeToggle } from './PlanModeToggle';

interface HeaderProps {
  // The conversation's working-directory display path, or null when the
  // conversation is folderless (the user hasn't chosen a folder). null
  // renders a faint "No folder" — commands still run, from the home
  // directory, but the header is honest that no folder was picked.
  displayPath: string | null;
  // Session-wide peek default (Chunk 3). Threaded through to the
  // sign-out popover, which surfaces an "Always show commands" toggle.
  peekDefault: boolean;
  onPeekDefaultChange: (value: boolean) => void;
  // Session-wide Plan Mode (Chunk 4). Rendered as a header pill between
  // the cwd and the avatar.
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
}

// Per-conversation header. Three slots: wordmark | cwd | right-group.
// The wordmark, Plan Mode toggle, and account menu reflect app-global
// state — each conversation renders its own Header but only the active
// conversation's is on screen, and the session-wide props keep them all
// in sync. The cwd slot is the one genuinely per-conversation piece.
export function Header({
  displayPath,
  peekDefault,
  onPeekDefaultChange,
  planMode,
  onPlanModeChange,
}: HeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center justify-between border-b-[0.5px] border-hairline px-6">
      <span className="font-serif text-[17px] font-medium text-ink">Vorlox</span>
      {displayPath === null ? (
        <span className="font-mono text-[12px] italic text-ink-micro mx-4">
          No folder
        </span>
      ) : (
        <span className="truncate font-mono text-[12px] text-ink-hint max-w-[40%] mx-4">
          {displayPath}
        </span>
      )}
      <div className="flex items-center gap-3">
        <PlanModeToggle on={planMode} onChange={onPlanModeChange} />
        <HeaderMenu
          peekDefault={peekDefault}
          onPeekDefaultChange={onPeekDefaultChange}
        />
      </div>
    </header>
  );
}
