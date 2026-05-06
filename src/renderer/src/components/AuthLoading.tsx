// Calm splash shown during initial auth hydration (token check + /me call).
// Just the wordmark on the off-white background — no spinner, no progress bar.
export function AuthLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-off-white">
      <h1
        className="font-soft text-gray-400"
        style={{ fontSize: '32px', fontWeight: 200, letterSpacing: '0.15em' }}
      >
        Vorlox
      </h1>
    </div>
  );
}
