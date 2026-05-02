interface HeaderProps {
  displayPath: string;
}

export function Header({ displayPath }: HeaderProps) {
  return (
    <header className="flex h-12 shrink-0 items-center border-b border-gray-200 px-6">
      <span className="text-[13px] font-normal text-gray-500">{displayPath}</span>
    </header>
  );
}
