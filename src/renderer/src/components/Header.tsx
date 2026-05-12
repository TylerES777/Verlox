import { HeaderMenu } from './HeaderMenu';

interface HeaderProps {
  displayPath: string;
  // Session-wide peek default (Chunk 3). Threaded through to the
  // sign-out popover, which surfaces an "Always show commands" toggle.
  peekDefault: boolean;
  onPeekDefaultChange: (value: boolean) => void;
}

export function Header({
  displayPath,
  peekDefault,
  onPeekDefaultChange,
}: HeaderProps) {
  return (
    <header className="grid h-12 shrink-0 grid-cols-3 items-center border-b-[0.5px] border-hairline px-6">
      {/* Wordmark left */}
      <div className="justify-self-start">
        <span className="font-serif text-[17px] font-medium text-ink">Vorlox</span>
      </div>
      {/* Cwd center */}
      <div className="justify-self-center">
        <span className="font-mono text-[12px] text-ink-hint">{displayPath}</span>
      </div>
      {/* Avatar right */}
      <div className="justify-self-end">
        <HeaderMenu
          peekDefault={peekDefault}
          onPeekDefaultChange={onPeekDefaultChange}
        />
      </div>
    </header>
  );
}
