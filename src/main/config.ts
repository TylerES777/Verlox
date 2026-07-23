// Backend URL switch. Production builds point at the Railway deploy;
// dev builds (npm run dev) point at the local Hono server.
//
// Selection: electron-vite injects MAIN_VITE_DEV / IS_DEV-style flags via
// import.meta.env.DEV. Use that to pick. We don't read process.env.NODE_ENV
// here because Electron sets NODE_ENV=production for packaged builds even
// when no MODE override happens.

const isDev = import.meta.env.DEV;

// TEMP (do NOT commit): dev pointed at the Railway prod backend so the
// desktop app can sign in without a local backend + DB running. Restore
// the localhost:3001 dev branch before committing.
// api.verlox.app is OUR domain (registered on Vercel, CNAMEd to the backend
// project). Hardcoding a host-owned URL stranded every installed app when
// Railway died — a user-owned domain means the host behind it can change
// without ever shipping an app update again.
export const BACKEND_URL = isDev
  ? 'https://api.verlox.app'
  : 'https://api.verlox.app';
