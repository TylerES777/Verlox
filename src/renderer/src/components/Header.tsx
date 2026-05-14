import { HeaderMenu } from './HeaderMenu';
import { PlanModeToggle } from './PlanModeToggle';

interface HeaderProps {
  displayPath: string;
  // Session-wide peek default (Chunk 3). Threaded through to the
  // sign-out popover, which surfaces an "Always show commands" toggle.
  peekDefault: boolean;
  onPeekDefaultChange: (value: boolean) => void;
  // Session-wide Plan Mode (Chunk 4). Rendered as a header pill between
  // the cwd and the avatar.
  planMode: boolean;
  onPlanModeChange: (value: boolean) => void;
}

// Chunk 4 layout: flex with justify-between instead of the previous
// grid-cols-3. Three slots: wordmark | cwd | right-group. The cwd
// truncates if it would push the right group off-screen — paths can be
// arbitrarily long on Windows.
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
      <span className="truncate font-mono text-[12px] text-ink-hint max-w-[40%] mx-4">
        {displayPath}
      </span>
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
