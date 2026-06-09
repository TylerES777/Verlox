# Verlox

**The AI terminal that won't ruin your projects.**

[verlox.app](https://www.verlox.app) · [Download for Windows](https://github.com/TylerES777/Verlox/releases/latest/download/Verlox-Setup.exe) · [Changelog](https://www.verlox.app/changelog)

Verlox is an AI terminal for Windows with eleven models built in plus one that runs entirely offline. Every command the AI proposes is planned, risk-scored, and waiting for your approval, with one-click undo on anything it changes. Move fast. Keep your projects intact.

![Verlox screenshot](https://www.verlox.app/og.png)

## Why this exists

Most AI terminals run first and ask questions later. You find out what broke afterward, and recovery means git, your memory, or luck.

Verlox flips that. You see a numbered plan with the exact commands and a risk score on every step *before* anything runs. Risky things (deletes, force-pushes, production access) stop and ask. Anything the AI deletes or overwrites is saved to a Recovery Vault and restorable with one click.

Same speed as letting AI rip. None of the regret.

## What's inside

### Eleven hosted models, one offline, plus your own

Pick the right model from a single menu, all credit-billed (or free for the offline / BYOK options):

- **Anthropic**: Haiku, Sonnet, Opus
- **OpenAI**: GPT-4o mini, GPT-4o, o3 (reasoning)
- **Google**: Gemini Flash, Gemini 2.5 Pro
- **xAI**: Grok 4.3
- **Open weights**: Llama 3.3 70B, DeepSeek V3, Qwen 2.5 72B
- **Built-in offline**: Llama 3.2 3B, downloads once and then runs entirely on your machine. No network, no credits.
- **Ollama integration**: auto-detects any model you've pulled via Ollama.
- **BYOK**: paste your own OpenAI or Anthropic API key, calls go direct from your machine.

### The safety layer

- **Approval plans**: every request becomes a numbered plan with the real commands and the files they will touch.
- **Risk scoring**: low for reads, medium for installs and edits, high for deletes and force-pushes. The risky steps always stop and ask.
- **Permission rules**: per-capability "always allow / ask every time / never allow." Set them once.
- **Recovery Vault**: deleted and overwritten files land here, restorable with one click. Keep for 24 hours, 7 days, or forever.
- **Simulate (dry run)**: preview a plan's full outcome with before/after diffs before running it for real.
- **Timeline replay**: every action the AI took, when, with which risk and result.

### Calm, focused desktop app

- A real Electron desktop app, not a chat window pretending to be one.
- Plain-language explanations on every reply.
- Long-running processes (dev servers, watchers) get their own pane.
- Paste a screenshot of an error to ask about it.
- Auto-updates in the background; install when you quit.

## Pricing

- **Free**: 8 fast models, 15 credits a day, daily trial of the flagship Pro models, the built-in offline model, and the full safety layer (plans, risk scoring, permissions, 24-hour Recovery Vault).
- **Pro · $15/mo**: Sonnet, Opus, o3, Gemini 2.5 Pro, 500 credits a week, Sandbox dry-run with diffs, full Timeline replay, Recovery Vault kept 7 days or forever, generous image uploads.

Cancel any time from the Stripe customer portal.

## Install (Windows)

1. Download the latest installer: [Verlox-Setup.exe](https://github.com/TylerES777/Verlox/releases/latest/download/Verlox-Setup.exe)
2. Verlox is a new, independent app, so Windows SmartScreen may show a *"Windows protected your PC"* prompt. Click **More info → Run anyway**. (Code signing is coming.)
3. Sign in with email, or use a BYOK custom provider with no account required.

macOS and Linux are not yet available. They're on the roadmap.

## Comparison

| | Other AI terminals | Verlox |
|---|---|---|
| Execution | Run first, ask questions later | Every step planned and risk-scored first |
| Visibility | You find out what broke afterward | You see exactly what will change |
| Recovery | git, your memory, or luck | One-click restore on anything deleted |
| Model choice | Usually one provider | Eleven hosted models, one offline, BYOK |
| Offline | No | Built-in offline model |

## Tech

Electron 33, React 18, TypeScript (strict). xterm.js for the terminal. `@homebridge/node-pty-prebuilt-multiarch` for the Windows pty. Tailwind for styling. Backend: Hono + Postgres + Drizzle + Stripe + Better Auth on Railway. Hosted models route through Anthropic direct (for prompt caching) or OpenRouter (for everything else). The bundled offline model runs via llama.cpp's `llama-server` on a random local port.

## Project layout

```
src/
├── main/                       # Electron main process
│   ├── agent.ts                # Engine dispatcher (verlox/custom/ollama/local)
│   ├── agent-anthropic.ts      # BYOK Anthropic adapter
│   ├── agent-openai.ts         # BYOK + Ollama + local OpenAI-compat adapter
│   ├── backend-client.ts       # Verlox backend HTTP (auth + AI + billing)
│   ├── command-runner.ts       # Spawn/stream + Windows tree-kill
│   ├── local-model.ts          # Bundled llama.cpp lifecycle + download
│   ├── ollama.ts               # Local Ollama daemon probe
│   ├── pty-manager.ts          # Per-tab pty + serialization
│   ├── settings-store.ts       # Encrypted provider keys, permissions
│   ├── snapshot-manager.ts     # Per-project git snapshots
│   ├── vault-manager.ts        # Recovery Vault on-disk storage
│   ├── timeline-manager.ts     # Action ledger
│   ├── updater.ts              # electron-updater integration
│   └── index.ts                # Entry, IPC handlers, lifecycle
├── preload/
│   └── index.ts                # contextBridge: typed window.api
├── renderer/src/
│   ├── components/             # AgentPanel, Sidebar, TerminalView, SettingsView,
│   │                           # VaultView, TimelineView, ConversationsShell, ...
│   ├── contexts/               # Auth, Tier, Usage, Upgrade, UpdateStatus
│   └── lib/                    # credits, lineDiff, terminalRegistry, ...
└── shared/
    ├── types.ts                # IPC + domain types (single source of truth)
    ├── ipc-channels.ts         # Channel-name constants
    └── risk.ts                 # Risk assessment + capabilities
```

## Scripts

- `npm run dev`: Electron + renderer HMR
- `npm run build`: production build (main + preload + renderer to `out/`)
- `npm run package:win`: package + installer (CI runs this with `--publish always`)
- `npm run lint`: ESLint
- `npm run format`: Prettier

## Releases

Releases are built and published by GitHub Actions on a `v*` tag push. The CI runner has the C++ toolchain needed to compile `node-pty` for the Electron ABI; local release builds from this repo are not supported.

```
npm version patch
git push --follow-tags
# CI builds, publishes a non-draft release, and uploads latest.yml + installer
```

The auto-updater (electron-updater) reads `latest.yml` from the latest non-draft release; users get the new version on next quit automatically.

## Roadmap

- macOS and Linux builds
- Code-signed installer (no more SmartScreen prompt)
- Per-project memory and conventions
- Background tasks (long-running agents you check in on)
- More built-in offline models

## Feedback

Bugs and ideas: [GitHub Issues](https://github.com/TylerES777/Verlox/issues). I read every one.

## License

Source-available, all rights reserved. Compiled binaries are free to use under the terms shown in the installer.

---

Built by Felix Cristobal. Verlox is an independent project.
