# Vorlox

Vorlox — a conversational terminal for people who prefer talking to their tools.

The desktop app: Electron + React + TypeScript. Sends the user's plain-English intent to the Vorlox backend (`/api/translate`), runs the resulting shell command through the existing spawn/stream infrastructure, and streams a calm explanation below the output via `/api/explain` SSE. Auth is bearer-token via the backend; the session token lives encrypted on the OS keychain (Electron `safeStorage`) and never crosses the IPC boundary into the renderer.

## Scripts

- `npm run dev` — start Electron with renderer HMR; DevTools auto-opens detached
- `npm run build` — production build (main + preload + renderer to `out/`)
- `npm run lint` — ESLint over `.ts` / `.tsx`
- `npm run format` — Prettier write

## Stack

- Electron + electron-vite — main / preload / renderer bundles
- React 18 + TypeScript — strict mode, ESM throughout
- Tailwind CSS — styling, off-white background and gray-700 primary text
- electron-store + Electron's `safeStorage` — encrypted session token persistence

## Layout

```
src/
├── main/
│   ├── auth-store.ts          # safeStorage wrapper for the bearer token
│   ├── backend-client.ts      # all backend HTTP (auth + AI endpoints)
│   ├── command-runner.ts      # spawn/stream + Windows tree-kill (taskkill /T /F)
│   ├── config.ts              # BACKEND_URL dev/prod switch
│   ├── detect-environment.ts  # platform + shell detection at app launch
│   ├── store.ts               # cwd persistence with ~ expansion
│   └── index.ts               # Electron entry, IPC handlers, before-quit cleanup
├── preload/
│   └── index.ts               # contextBridge — typed window.api
├── renderer/src/
│   ├── components/            # LoginScreen, ConversationScreen, Header,
│   │                          # HeaderMenu, Message, TranslationCard, Input,
│   │                          # Conversation, AuthLoading
│   ├── contexts/AuthContext.tsx
│   ├── hooks/                 # useAuth, useCommands, useCwd
│   └── App.tsx                # AuthGate (hydrating | unauthenticated | authenticated)
└── shared/
    ├── ipc-channels.ts        # all IPC channel name constants
    ├── path-utils.ts          # tildify
    └── types.ts               # shared types (CwdInfo, AuthUser, TranslateResponse, ...)
```

## Backend connection

The desktop talks to a Hono backend (separate repo). URL switches based on `import.meta.env.DEV`:

| Build | URL |
|---|---|
| `npm run dev` | `http://localhost:3001` |
| Packaged production | `https://backend-production-08f5e.up.railway.app` |

To test against production during dev (e.g., to verify a flow end-to-end without a local backend running), edit `src/main/config.ts` to hardcode the production URL temporarily. **Revert before committing.**

## Auth flow

- Sign-up / sign-in returns `{ token, user }`. The token is encrypted via `safeStorage.encryptString` (DPAPI on Windows, keychain on macOS, libsecret on Linux) and persisted to `<userData>/auth.json` via electron-store.
- All protected requests include `Authorization: Bearer <token>` and `Origin: app://vorlox`. The synthetic origin is required by the backend's better-auth CSRF check; it must be present in the backend's `TRUSTED_ORIGINS` env var.
- The token **never crosses the IPC boundary** — it stays in main; the renderer only sees the resulting `AuthUser` (`{ id, email }`) via the result shape.
- A `401` from any protected endpoint (translate, explain, `/me`) triggers a bounce to the login screen with a "Your session expired" banner. Running shell processes are killed (same code path as the Stop button); conversation history is cleared; remote sign-out is fired best-effort.

## Conversation pipeline

User types intent → `submitInput` →

1. `POST /api/translate` with `{ userInput, context: { cwd, platform, shell } }`. Synchronous JSON response.
2. Branch on the response:
   - `command === ""` and not a cd → `'refused'` (model declined; calm refusal text in `explanation`)
   - `isCdCommand` → expand `~/...` in main, call `setCwd` (validates path existence), render "Switched to ~/..."
   - `requiresConfirmation` → `[Cancel] [Run]` card; Cancel auto-focuses
   - else → auto-run via the existing `command-runner`
3. On natural exit (signal === null) **and** non-empty output: `POST /api/explain`. Stream tokens into `finalExplanation` field; render below output.

Silent successful commands (exit 0 with empty output, e.g. `mkdir`) skip the explain round-trip.

## Phase 2 functionality preserved

- Shell command spawning + streaming output (per-command IPC channels)
- Stop button — `child.kill()` on POSIX, async `taskkill /T /F` on Windows
- Process-tree cleanup on app quit — synchronous `execSync('taskkill /T /F')` on Windows in `before-quit`. The synchronous variant matters: an async spawn races Electron's exit and leaves orphans.

## Calm-aesthetic constraints

These are deliberate; preserve them when extending:

- No spinners. No animation on loading states. Stillness is the calm.
- No exclamation points. No emoji. No "Sure!" or "Great!".
- Sans-serif for prose; monospace only for command + raw output.
- Errors are 1-sentence plain English ending with a period.
- Confirmation buttons: Cancel default-focus, Enter cancels (don't make accidental Enter destructive).
- Sign-out is one click via the avatar menu — no "are you sure?" dialog.

## Gotchas

The desktop app uses the same `app://vorlox` origin convention documented in the backend repo's README. If sign-up / sign-in / sign-out starts returning `403 INVALID_ORIGIN` in production, the backend's `TRUSTED_ORIGINS` env var is the first place to look.

The `import.meta.env.DEV` flag in `src/main/config.ts` is what drives the dev/prod URL switch. It's injected by electron-vite during the build. Reading `process.env.NODE_ENV` would not work — Electron sets `NODE_ENV=production` for packaged builds even if no `MODE` override happens, but `import.meta.env.DEV` reflects the actual build mode.
