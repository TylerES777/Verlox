import type { CommandMessage } from '../hooks/useCommands';

interface MessageProps {
  message: CommandMessage;
  onStop: (id: string) => void;
}

export function Message({ message, onStop }: MessageProps) {
  return (
    <div className="mb-6">
      <div className="flex items-baseline gap-3">
        <pre className="m-0 flex-1 whitespace-pre-wrap break-words font-mono text-[14px] font-medium text-gray-700">
          {message.command}
        </pre>
        {message.status === 'running' && (
          <button
            type="button"
            onClick={() => onStop(message.id)}
            className="text-[12px] font-normal text-gray-400 hover:text-gray-600 focus:outline-none"
          >
            stop
          </button>
        )}
      </div>

      {message.output.length > 0 && (
        <pre className="m-0 mt-1 whitespace-pre-wrap break-words font-mono text-[13px] leading-[1.6] text-gray-600">
          {message.output}
        </pre>
      )}

      {message.status === 'running' && (
        <div className="mt-1 font-mono text-[13px] text-gray-400">…</div>
      )}

      {message.status === 'exited' && message.exitCode != null && message.exitCode !== 0 && (
        <div className="mt-1 text-[12px] text-gray-400">exit code {message.exitCode}</div>
      )}

      {message.status === 'killed' && (
        <div className="mt-1 text-[12px] text-gray-400">stopped</div>
      )}
    </div>
  );
}
