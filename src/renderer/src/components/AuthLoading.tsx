// Calm splash shown during initial auth hydration (token check + /me call).
// Full-bleed white with the wordmark at top and footer microcopy at bottom,
// matching the LoginScreen shell so the transition from hydrating →
// unauthenticated only fills in the welcome block + form, no layout jump.
//
// No card-in-window wrapper here: auth screens are full-bleed because the
// only content is small and centered. Card-in-window resumes for the
// conversation screen where content fills the card horizontally.
export function AuthLoading() {
  return (
    <div className="flex h-full w-full flex-col bg-card">
      <div className="flex justify-center pb-2 pt-8">
        <span className="font-mono text-[14px] font-medium tracking-tight text-ink">
          <span className="text-amber">›</span>vorlox
        </span>
      </div>
      <div className="flex-1" />
      <div className="flex justify-center pb-8">
        <span className="text-[11px] text-ink-micro">A calm, conversational terminal.</span>
      </div>
    </div>
  );
}
