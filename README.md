# Vorlox

Vorlox — a conversational terminal for people who prefer talking to their tools.

## Scripts

- `npm run dev` — start Electron with renderer HMR
- `npm run build` — production build (main + preload + renderer)
- `npm run lint` — ESLint over `.ts` / `.tsx`
- `npm run format` — Prettier write

## Stack

Electron + electron-vite, React 18 + TypeScript, Tailwind CSS, ESLint, Prettier.

## Layout

```
src/
  main/      Electron main process
  preload/   contextBridge IPC surface
  renderer/  React UI
  shared/    Types and IPC channel constants
```

## TODO

- Environment variable handling (`.env`) will be added when API integration lands in a later phase.
