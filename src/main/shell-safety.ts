import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';

// Phase 3 of Verlox's safety story: a delete safety bin.
//
// The snapshot vault (snapshot-manager.ts) can already rewind the guarded
// folder, but that's a whole-folder time machine. This is the lighter,
// everyday net: when a delete command runs in the interactive terminal —
// typed by the user OR by an AI agent driving the shell — the deleted files
// go to the Windows Recycle Bin instead of being erased outright. Familiar,
// instant, and works anywhere on the machine (not just inside a guarded
// folder).
//
// How: we don't parse the user's keystrokes. Instead we inject a tiny startup
// script into the PowerShell that backs each terminal. It defines a global
// `Remove-Item` function that shadows the built-in cmdlet and routes deletes
// to the Recycle Bin. Because rm / del / erase / rd / ri are all aliases that
// resolve to the *name* "Remove-Item" at call time (and a function beats a
// cmdlet of the same name), this single override covers every common delete
// verb without touching the user's own profile or aliases.
//
// The script is passed via -EncodedCommand (base64 of UTF-16LE) so we never
// have to fight shell quoting. The profile still loads first (we keep the
// user's prompt/aliases); our override runs after it, so it wins. If anything
// in the script errors, -NoExit means the user still gets a working prompt —
// worst case is "no safety net", never "broken terminal".

// The PowerShell that runs at the top of every Verlox terminal. Kept
// defensive: if the Recycle Bin API is missing or a delete fails, we REPORT
// and LEAVE THE FILE IN PLACE rather than fall back to a permanent delete —
// the whole point is to avoid irreversible mistakes.
const SAFE_DELETE_PS = `
$ErrorActionPreference = 'Continue'
try { Add-Type -AssemblyName Microsoft.VisualBasic -ErrorAction Stop } catch {}

function global:Remove-Item {
  [CmdletBinding()]
  param(
    [Parameter(Position=0, ValueFromPipeline=$true, ValueFromRemainingArguments=$true)]
    [object[]]$Path,
    [string[]]$LiteralPath,
    [switch]$Recurse,
    [switch]$Force,
    [string]$Include,
    [string]$Exclude,
    [string]$Filter,
    [switch]$WhatIf,
    [switch]$Confirm
  )
  process {
    $items = @()
    if ($Path) { $items += $Path }
    if ($LiteralPath) { $items += $LiteralPath }
    foreach ($raw in $items) {
      if ($null -eq $raw) { continue }
      $itemPath = if ($raw -is [System.IO.FileSystemInfo]) { $raw.FullName } else { [string]$raw }
      if ([string]::IsNullOrWhiteSpace($itemPath)) { continue }

      $resolved = @()
      try { $resolved = @(Resolve-Path -Path $itemPath -ErrorAction Stop | ForEach-Object { $_.Path }) }
      catch {
        try { $resolved = @((Resolve-Path -LiteralPath $itemPath -ErrorAction Stop).Path) } catch {}
      }
      if ($resolved.Count -eq 0) {
        Write-Error ("Verlox: '" + $itemPath + "' was not found. Nothing deleted.")
        continue
      }

      foreach ($p in $resolved) {
        if ($WhatIf) {
          Write-Host ("What if: Verlox would move '" + $p + "' to the Recycle Bin.")
          continue
        }
        try {
          if (Test-Path -LiteralPath $p -PathType Container) {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          } else {
            [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin')
          }
          Write-Host ("Verlox: moved '" + $p + "' to the Recycle Bin (recoverable).") -ForegroundColor DarkYellow
        } catch {
          Write-Error ("Verlox: couldn't safely delete '" + $p + "' (" + $_.Exception.Message + "). Left it in place.")
        }
      }
    }
  }
}

# --- Verlox shell integration (OSC 133) ------------------------------------
# Emit invisible markers around each prompt / command / output so the app can
# segment the stream into command blocks (and translate output per command).
# The markers are written via [Console]::Write as SIDE EFFECTS — PSReadLine
# strips escape sequences out of the prompt's return STRING, so embedding them
# there doesn't survive. The command text rides along in the C marker via
# GetBufferState. Defensive: any failure leaves a normal, working prompt.
try {
  $Global:__VerloxOrigPrompt = $Function:prompt
  $Global:__VerloxReady = $false
  function Global:prompt {
    $ok = $?
    $ec = $LASTEXITCODE
    if ($null -eq $ec) { $ec = 0 }
    # Force an integer: the D marker must always carry a parseable code, or
    # the app can't tell "succeeded" from "unknown".
    try { $ec = [int]$ec } catch { $ec = 0 }
    # Native cmdlet errors don't set $LASTEXITCODE — fall back to $? so a
    # failed command still reports a non-zero exit.
    if (-not $ok -and $ec -eq 0) { $ec = 1 }
    $e = [char]27
    $b = [char]7
    # D (previous command finished, with its exit code) + A (prompt start).
    if ($Global:__VerloxReady) { [Console]::Write("$e]133;D;$ec$b") }
    $Global:__VerloxReady = $true
    [Console]::Write("$e]133;A$b")
    $orig = ''
    try { if ($Global:__VerloxOrigPrompt) { $orig = & $Global:__VerloxOrigPrompt } } catch { $orig = '' }
    if ([string]::IsNullOrEmpty($orig)) {
      $orig = "PS $($ExecutionContext.SessionState.Path.CurrentLocation)$('>' * ($NestedPromptLevel + 1)) "
    }
    $orig
  }
  if (Get-Command Set-PSReadLineKeyHandler -ErrorAction SilentlyContinue) {
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
      $line = $null
      $cursor = $null
      try { [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor) } catch {}
      # C (command submitted / output begins), carrying the command text.
      [Console]::Write("$([char]27)]133;C;$line$([char]7)")
      [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
  }
} catch {}

Write-Host 'Verlox safety on: deletes here go to the Recycle Bin, so they can be undone.' -ForegroundColor DarkGray
`;

// Base64-encode the script as UTF-16LE, the form PowerShell's
// -EncodedCommand expects. Sidesteps every quoting headache of passing a
// multi-line script as a single command-line argument.
function encodeForPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

// --- POSIX shell integration (macOS / Linux) -------------------------------
// The same OSC 133 marks the PowerShell script emits, for zsh and bash, so
// the Blocks view works identically on every platform. We do NOT edit the
// user's dotfiles: an init script is written to a temp dir and pointed at
// with --rcfile (bash) or ZDOTDIR (zsh). Both first source the user's real
// config, so their prompt, aliases, and PATH are untouched.
//
// Everything is wrapped so a failure degrades to "no blocks", never "broken
// shell": the marks are emitted by small functions that can't abort the
// prompt, and if the temp file can't be written we spawn the plain shell.
//
// The mark protocol (identical to the PowerShell side):
//   ESC]133;A         prompt start
//   ESC]133;C;<cmd>   command submitted, output begins
//   ESC]133;D;<code>  command finished, with exit status

const POSIX_MARKS = String.raw`
__verlox_mark_a() { printf '\033]133;A\007'; }
__verlox_mark_c() { printf '\033]133;C;%s\007' "$1"; }
__verlox_mark_d() { printf '\033]133;D;%s\007' "$1"; }
`;

const ZSH_INIT = `
# Load the user's own zsh config first, so their setup wins.
if [ -n "$VERLOX_ORIG_ZDOTDIR" ] && [ -f "$VERLOX_ORIG_ZDOTDIR/.zshrc" ]; then
  ZDOTDIR="$VERLOX_ORIG_ZDOTDIR"
  . "$VERLOX_ORIG_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  . "$HOME/.zshrc"
fi
${POSIX_MARKS}
# preexec runs after a command line is accepted, before it executes: $1 is
# the command text. precmd runs just before each prompt is drawn, so $? there
# is the exit status of the command that just finished.
__verlox_preexec() { __verlox_mark_c "$1"; }
__verlox_precmd() {
  local ec=$?
  if [ -n "$__verlox_ready" ]; then __verlox_mark_d "$ec"; fi
  __verlox_ready=1
  __verlox_mark_a
}
autoload -Uz add-zsh-hook 2>/dev/null && {
  add-zsh-hook preexec __verlox_preexec
  add-zsh-hook precmd __verlox_precmd
}
`;

const BASH_INIT = `
# Load the user's own bash config first, so their setup wins. --rcfile
# replaces ~/.bashrc entirely, so sourcing it back is required.
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi
${POSIX_MARKS}
# bash has no preexec, so the DEBUG trap stands in. It fires for every
# simple command — including the ones inside PROMPT_COMMAND — so we only
# emit the mark for the first command after a prompt was drawn.
__verlox_preexec() {
  [ -n "$COMP_LINE" ] && return
  [ -z "$__verlox_at_prompt" ] && return
  __verlox_at_prompt=
  __verlox_mark_c "$BASH_COMMAND"
}
__verlox_precmd() {
  local ec=$?
  if [ -n "$__verlox_ready" ]; then __verlox_mark_d "$ec"; fi
  __verlox_ready=1
  __verlox_at_prompt=1
  __verlox_mark_a
}
trap '__verlox_preexec' DEBUG
PROMPT_COMMAND="__verlox_precmd\${PROMPT_COMMAND:+; \$PROMPT_COMMAND}"
`;

// Write an init script to a per-user temp dir. Returns null if the write
// fails — the caller then spawns the shell plain.
function writeInitScript(name: string, contents: string): string | null {
  try {
    const dir = join(tmpdir(), 'verlox-shell-integration');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, contents, { encoding: 'utf8', mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

// Build the shell launch for a Verlox terminal.
//  - Windows: PowerShell with the safe-delete override injected. The profile
//    still loads (we keep the user's environment); -NoExit keeps the session
//    interactive after our startup script runs.
//  - macOS / Linux: the user's own shell, with an init script layered on top
//    that sources their config and then adds OSC 133 marks. Any shell we
//    don't have hooks for (fish, etc.) launches unchanged — it simply gets
//    no Blocks, which is the correct graceful degradation.
export function buildSafeShell(): {
  file: string;
  args: string[];
  env?: Record<string, string>;
} {
  if (process.platform === 'win32') {
    return {
      file: 'powershell.exe',
      args: [
        '-NoLogo',
        '-NoExit',
        '-EncodedCommand',
        encodeForPowerShell(SAFE_DELETE_PS),
      ],
    };
  }

  const shellPath = process.env.SHELL || '/bin/bash';
  const shellName = basename(shellPath);

  if (shellName === 'zsh') {
    const dir = join(tmpdir(), 'verlox-shell-integration');
    const written = writeInitScript('.zshrc', ZSH_INIT);
    if (written) {
      return {
        file: shellPath,
        args: ['-i'],
        // ZDOTDIR redirects zsh's startup to our directory; the original is
        // handed through so our .zshrc can source the user's real config.
        env: {
          ZDOTDIR: dir,
          VERLOX_ORIG_ZDOTDIR: process.env.ZDOTDIR || homedir(),
        },
      };
    }
  }

  if (shellName === 'bash') {
    const written = writeInitScript('verlox-bashrc', BASH_INIT);
    if (written) {
      return { file: shellPath, args: ['--rcfile', written, '-i'] };
    }
  }

  return { file: shellPath, args: [] };
}
