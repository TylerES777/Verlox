// Risk engine — the scoring spine for Vorlox's transparency layer.
//
// Vorlox's thesis is that AI actions should be understandable and reversible
// *before* they run. This module turns a raw shell command into a structured
// risk assessment that the approval plan, the permission system, and the
// delete-confirm flow all read from. It is intentionally a pure, dependency-
// free module living in `shared/` so the main process, preload, and renderer
// can all classify the same way.
//
// The classification is heuristic (pattern-based on the command text), tuned
// for Windows PowerShell/cmd plus common unix-style tools. It errs toward
// caution: anything it doesn't recognize is treated as MEDIUM, never LOW.

export type RiskLevel = 'low' | 'medium' | 'high';

// What a command fundamentally *does*. Drives both the risk score and the
// per-capability permission rules (always allow / ask / never).
export type Capability =
  | 'read' // read files, list folders, search, cd/pwd
  | 'inspect' // git status/log/diff, versions, non-secret env, process list
  | 'write' // create / modify / move / copy files
  | 'config' // modify configuration files specifically
  | 'install' // install packages / dependencies
  | 'build' // build, compile, test, run dev scripts
  | 'process' // start a long-lived process / local server
  | 'network' // outbound network request (esp. sending data)
  | 'git-history' // rewrite history: force-push, reset --hard, rebase
  | 'delete' // remove files / folders
  | 'deploy' // production deployment / publish a package
  | 'database' // schema or data changes (DROP/DELETE/migrations)
  | 'secrets' // read or expose secrets / credentials
  | 'permissions' // change file permissions / ownership
  | 'system' // shutdown / reboot / format / kill processes
  | 'unknown';

export interface RiskAssessment {
  level: RiskLevel;
  capability: Capability;
  // Short human label for the capability, e.g. "Delete files".
  label: string;
  // One-line plain-English reason for the score, shown under the badge.
  reason: string;
  // Best-effort list of file / folder paths the command references.
  files: string[];
}

interface Rule {
  capability: Capability;
  level: RiskLevel;
  label: string;
  reason: string;
  test: RegExp;
}

// Rules are evaluated in order; the FIRST match wins for a single (sub)command.
// High-risk patterns come first so a destructive flag isn't masked by a more
// generic earlier match. Keep the most specific patterns above broader ones.
const RULES: Rule[] = [
  // ----- HIGH -------------------------------------------------------------
  {
    capability: 'secrets',
    level: 'high',
    label: 'Access secrets',
    reason: 'Reads or exposes credentials, keys, or .env secrets.',
    test: /(\.env(\.[\w-]+)?\b|\bid_rsa\b|\.pem\b|\.key\b|\b(secret|password|passwd|credential|api[-_]?key|access[-_]?token|private[-_]?key)\b|\bkeychain\b|credential\s*manager)/i,
  },
  {
    capability: 'deploy',
    level: 'high',
    label: 'Deploy / publish',
    reason: 'Pushes to production or publishes a release — affects live users.',
    test: /\b(railway\s+(up|deploy)|vercel\s+(deploy\s+)?--prod|vercel\s+--prod|netlify\s+deploy[^|]*--prod|fly\s+deploy|(npm|yarn|pnpm)\s+publish|docker\s+push|gh\s+release\s+create|eb\s+deploy|gcloud\s+app\s+deploy|kubectl\s+(apply|delete)|terraform\s+(apply|destroy))\b/i,
  },
  {
    capability: 'database',
    level: 'high',
    label: 'Database change',
    reason: 'Alters database schema or data and may be irreversible.',
    test: /(\b(DROP|TRUNCATE|ALTER)\s+(TABLE|DATABASE|SCHEMA|INDEX)\b|\bDELETE\s+FROM\b|\b(prisma|drizzle-kit|knex|sequelize|typeorm|alembic|rails\s+db)\b[^|]*\b(migrate|migration|reset|push|drop)\b|\bdb\s+push\b|\bmongo[^|]*\.drop\()/i,
  },
  {
    capability: 'git-history',
    level: 'high',
    label: 'Rewrite git history',
    reason: 'Force-push / hard reset / rebase can permanently lose commits.',
    test: /\bgit\s+(push\s+[^|]*(--force\b|-f\b)|reset\s+--hard|rebase\b|filter-branch\b|reflog\s+expire|push\s+[^|]*--mirror)/i,
  },
  {
    capability: 'delete',
    level: 'high',
    label: 'Delete files',
    reason: 'Removes files or folders.',
    test: /(\b(rm|rmdir|rd|del|erase|unlink)\b|Remove-Item\b|\bri\b|Clear-Content\b|\bgit\s+clean\b|\b(rimraf|del-cli)\b)/i,
  },
  {
    capability: 'system',
    level: 'high',
    label: 'System / process control',
    reason: 'Stops processes or changes machine state.',
    test: /\b(shutdown|reboot|Restart-Computer|Stop-Computer|format|diskpart|mkfs|kill|killall|pkill|taskkill|Stop-Process)\b/i,
  },
  {
    capability: 'permissions',
    level: 'high',
    label: 'Change permissions',
    reason: 'Changes file permissions or ownership.',
    test: /\b(chmod|chown|chgrp|icacls|takeown|attrib|Set-Acl)\b/i,
  },
  {
    capability: 'network',
    level: 'high',
    label: 'Send data over network',
    reason: 'Makes an outbound request that sends data off the machine.',
    test: /\b(curl|wget|Invoke-RestMethod|Invoke-WebRequest|iwr|http)\b[^|]*(-X\s*(POST|PUT|PATCH|DELETE)|--data|--upload-file|-d\s|-T\s|-Method\s*(POST|PUT|PATCH|DELETE))/i,
  },

  // ----- MEDIUM -----------------------------------------------------------
  {
    capability: 'install',
    level: 'medium',
    label: 'Install packages',
    reason: 'Adds dependencies / software to the project or machine.',
    test: /\b((npm|pnpm|yarn|bun)\s+(install|add|i)\b|pip3?\s+install\b|(cargo|go)\s+(add|get|install)\b|(apt|apt-get|brew|choco|winget|scoop|dnf|pacman)\s+install\b|dotnet\s+add\b|gem\s+install\b|composer\s+(require|install)\b)/i,
  },
  {
    capability: 'config',
    level: 'medium',
    label: 'Modify config',
    reason: 'Edits a configuration file.',
    test: /(>>?\s*[^|]*\.(json|ya?ml|toml|ini|env|conf|config|xml|properties)\b|(Set-Content|Out-File|Add-Content)[^|]*\.(json|ya?ml|toml|ini|conf|config)\b|\b(tsconfig|package\.json|\.eslintrc|\.prettierrc|vite\.config|webpack\.config|next\.config|tailwind\.config|dockerfile|docker-compose)\b[^|]*(>|Set-Content|Out-File))/i,
  },
  {
    capability: 'network',
    level: 'medium',
    label: 'Network request',
    reason: 'Fetches data from the network (read-only request).',
    test: /\b(curl|wget|Invoke-RestMethod|Invoke-WebRequest|iwr|git\s+clone|git\s+pull|git\s+fetch)\b/i,
  },
  {
    capability: 'write',
    level: 'medium',
    label: 'Write files',
    reason: 'Creates, edits, moves, or copies files.',
    test: /(>>?\s*\S|\b(touch|cp|copy|mv|move|mkdir|md|ren|rename)\b|New-Item\b|Set-Content\b|Out-File\b|Add-Content\b|Copy-Item\b|Move-Item\b|Rename-Item\b|\bgit\s+(add|commit|checkout|switch|branch|stash|merge|tag|init|mv)\b)/i,
  },
  {
    capability: 'build',
    level: 'medium',
    label: 'Build / test',
    reason: 'Compiles, builds, or runs the test/dev pipeline.',
    test: /\b((npm|pnpm|yarn|bun)\s+(run|build|test|dev|start|lint)\b|tsc\b|vite\b|webpack\b|rollup\b|esbuild\b|(cargo|go|dotnet|mvn|gradle)\s+(build|test|run)\b|make\b|jest\b|vitest\b|pytest\b|mocha\b|eslint\b|prettier\b)/i,
  },
  {
    capability: 'process',
    level: 'medium',
    label: 'Run a program',
    reason: 'Starts a script or long-lived process.',
    test: /\b(node|python3?|deno|bun|ruby|php|java|dotnet\s+run|docker\s+(run|compose\s+up)|Start-Process)\b/i,
  },

  // ----- LOW --------------------------------------------------------------
  {
    capability: 'inspect',
    level: 'low',
    label: 'Inspect',
    reason: 'Reads status / metadata; changes nothing.',
    test: /\b(git\s+(status|log|diff|show|remote|branch$|describe|blame)|--version|-v\b|--help|-h\b|(npm|pnpm|yarn)\s+(ls|list|outdated|view|why)|env\b|printenv|Get-ChildItem\s+Env:|ps\b|Get-Process|top\b|whoami|hostname|date\b|uname)/i,
  },
  {
    capability: 'read',
    level: 'low',
    label: 'Read / search',
    reason: 'Reads files or lists folders; changes nothing.',
    test: /\b(cat|type|less|more|head|tail|bat|Get-Content|gc|ls|dir|Get-ChildItem|gci|tree|pwd|cd|Get-Location|Set-Location|echo|Write-Host|Write-Output|grep|findstr|Select-String|rg|ag|ack|find|fd|where|which|Get-Command|Test-Path|wc|sort|uniq|stat)\b/i,
  },
];

// A command line can be several commands chained with &&, ||, ;, or piped.
// Split into sub-commands so the assessment reflects the riskiest part.
function splitChain(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const LEVEL_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2 };

function classifyOne(sub: string): Rule | null {
  for (const rule of RULES) {
    if (rule.test.test(sub)) return rule;
  }
  return null;
}

// Best-effort extraction of file / folder paths the command touches: tokens
// with a file extension, a path separator, or a known config name. Quotes and
// leading flags are stripped. Used to show "files it will touch".
function extractFiles(command: string): string[] {
  const tokens = command.match(/(?:"[^"]+"|'[^']+'|\S+)/g) ?? [];
  const files: string[] = [];
  for (const raw of tokens) {
    const tok = raw.replace(/^['"]|['"]$/g, '');
    if (tok.startsWith('-')) continue; // flag
    const looksLikePath =
      /[\\/]/.test(tok) ||
      /\.[a-z0-9]{1,6}$/i.test(tok) ||
      /^(package\.json|tsconfig\.json|dockerfile|makefile|\.env)$/i.test(tok);
    // Skip URLs and obvious non-paths.
    if (looksLikePath && !/^https?:\/\//i.test(tok)) {
      files.push(tok);
    }
  }
  // De-dupe, cap to keep the UI tidy.
  return Array.from(new Set(files)).slice(0, 8);
}

// Classify a whole command line into a single risk assessment. When the line
// chains several commands, the riskiest sub-command's capability/level wins.
export function assessCommand(command: string): RiskAssessment {
  const subs = splitChain(command);
  let winner: Rule | null = null;
  for (const sub of subs) {
    const r = classifyOne(sub);
    if (!r) continue;
    if (!winner || LEVEL_RANK[r.level] > LEVEL_RANK[winner.level]) {
      winner = r;
    }
  }

  const files = extractFiles(command);

  if (!winner) {
    // Unrecognized — default to MEDIUM, never LOW, so unknown actions still
    // surface for approval.
    return {
      level: 'medium',
      capability: 'unknown',
      label: 'Unrecognized action',
      reason: "Vorlox can't categorize this command, so it's treated as medium risk.",
      files,
    };
  }

  return {
    level: winner.level,
    capability: winner.capability,
    label: winner.label,
    reason: winner.reason,
    files,
  };
}

// Display helpers (kept here so every surface labels risk identically).
export function riskLabel(level: RiskLevel): string {
  return level === 'low' ? 'Low risk' : level === 'medium' ? 'Medium risk' : 'High risk';
}

// The overall risk of a plan is the riskiest of its steps.
export function highestRisk(levels: RiskLevel[]): RiskLevel {
  let max: RiskLevel = 'low';
  for (const l of levels) {
    if (LEVEL_RANK[l] > LEVEL_RANK[max]) max = l;
  }
  return max;
}

// ---- Permissions ----------------------------------------------------------
// What the user allows Verlox to do, per capability:
//   always — run without asking
//   ask    — pause for approval (the default for anything that changes things)
//   never  — block: the step is refused and skipped
export type PermissionRule = 'always' | 'ask' | 'never';

export type CapabilityPermissions = Partial<Record<Capability, PermissionRule>>;

// Safe defaults: only pure reads/inspection run unattended; everything else
// asks. Nothing is blocked out of the box — the user opts into "never".
export const DEFAULT_PERMISSIONS: Record<Capability, PermissionRule> = {
  read: 'always',
  inspect: 'always',
  write: 'ask',
  config: 'ask',
  install: 'ask',
  build: 'ask',
  process: 'ask',
  network: 'ask',
  'git-history': 'ask',
  delete: 'ask',
  deploy: 'ask',
  database: 'ask',
  secrets: 'ask',
  permissions: 'ask',
  system: 'ask',
  unknown: 'ask',
};

export function permissionFor(
  perms: CapabilityPermissions | undefined,
  cap: Capability,
): PermissionRule {
  return perms?.[cap] ?? DEFAULT_PERMISSIONS[cap];
}

// The capabilities shown (in this order) in the Settings → Permissions UI.
// 'unknown' is internal and omitted.
export const PERMISSION_CAPABILITIES: { capability: Capability; label: string }[] = [
  { capability: 'read', label: 'Read files & list folders' },
  { capability: 'inspect', label: 'Inspect status (git, versions)' },
  { capability: 'write', label: 'Write / move files' },
  { capability: 'config', label: 'Modify config files' },
  { capability: 'install', label: 'Install packages' },
  { capability: 'build', label: 'Build & run tests' },
  { capability: 'process', label: 'Run programs / servers' },
  { capability: 'network', label: 'Network requests' },
  { capability: 'git-history', label: 'Rewrite git history' },
  { capability: 'delete', label: 'Delete files' },
  { capability: 'deploy', label: 'Deploy / publish' },
  { capability: 'database', label: 'Database changes' },
  { capability: 'secrets', label: 'Access secrets' },
  { capability: 'permissions', label: 'Change permissions' },
  { capability: 'system', label: 'System / process control' },
];
