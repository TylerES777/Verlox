import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';

// The signed-in user's billing tier, used to gate Pro-only features in
// the UI (Plan Mode, "Show as diagram"). Sourced from /api/usage, which
// reports the tier alongside the message count. Defaults to 'free' so
// features stay gated until we positively confirm Pro.
//
// Server-side enforcement is the real boundary (e.g. /api/diagram 403s
// free users); this context just drives the affordances so free users
// see locked controls instead of hitting errors.

type Tier = 'free' | 'pro';

interface TierContextValue {
  tier: Tier;
  isPro: boolean;
  // Re-fetch the tier (e.g. after an upgrade completes).
  refresh: () => void;
}

const TierContext = createContext<TierContextValue>({
  tier: 'free',
  isPro: false,
  refresh: () => {},
});

export function TierProvider({ children }: { children: ReactNode }) {
  const [tier, setTier] = useState<Tier>('free');

  const refresh = useCallback(() => {
    window.api
      .getUsage()
      .then((u) => {
        if (u && (u.tier === 'pro' || u.tier === 'free')) setTier(u.tier);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-check the tier whenever the window regains focus. After a user
  // completes Stripe checkout in their browser and switches back, this
  // picks up the new Pro tier (set by the webhook) without a restart.
  useEffect(() => {
    function onFocus() {
      refresh();
    }
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

  return (
    <TierContext.Provider value={{ tier, isPro: tier === 'pro', refresh }}>
      {children}
    </TierContext.Provider>
  );
}

export function useTier(): TierContextValue {
  return useContext(TierContext);
}
