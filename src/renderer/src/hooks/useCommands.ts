import { useCallback, useEffect, useState } from 'react';

export type CommandStatus = 'running' | 'exited' | 'killed';

export interface CommandMessage {
  id: string;
  command: string;
  cwd: string;
  output: string;
  status: CommandStatus;
  exitCode: number | null;
  signal: string | null;
  startedAt: number;
  endedAt: number | null;
}

export function useCommands(currentCwdDisplay: string): {
  messages: CommandMessage[];
  forceScrollVersion: number;
  runCommand: (command: string) => void;
  stopCommand: (id: string) => void;
} {
  const [messages, setMessages] = useState<CommandMessage[]>([]);
  const [forceScrollVersion, setForceScrollVersion] = useState(0);

  useEffect(() => {
    const offOutput = window.api.onCommandOutput(({ id, data }) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, output: m.output + data } : m)),
      );
    });

    const offExit = window.api.onCommandExit(({ id, code, signal }) => {
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id !== id) return m;
          const status: CommandStatus = signal != null ? 'killed' : 'exited';
          return {
            ...m,
            status,
            exitCode: code,
            signal,
            endedAt: Date.now(),
          };
        }),
      );
    });

    return () => {
      offOutput();
      offExit();
    };
  }, []);

  const runCommand = useCallback(
    (command: string) => {
      const trimmed = command.trim();
      if (trimmed.length === 0) return;
      const id = crypto.randomUUID();
      const message: CommandMessage = {
        id,
        command: trimmed,
        cwd: currentCwdDisplay,
        output: '',
        status: 'running',
        exitCode: null,
        signal: null,
        startedAt: Date.now(),
        endedAt: null,
      };
      setMessages((prev) => [...prev, message]);
      setForceScrollVersion((v) => v + 1);
      window.api.startCommand({ id, command: trimmed });
    },
    [currentCwdDisplay],
  );

  const stopCommand = useCallback((id: string) => {
    window.api.stopCommand(id);
  }, []);

  return { messages, forceScrollVersion, runCommand, stopCommand };
}
