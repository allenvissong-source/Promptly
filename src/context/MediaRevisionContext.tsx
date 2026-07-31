import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

// A single app-wide "material library changed" counter. Any material mutation
// (import / move / delete / rename) bumps it; consumers that cache derived
// material data (the gen-area @ image pools) watch `rev` as an effect dependency
// and reload when it changes. This keeps those caches in sync with the library
// without threading a reload prop through every intermediate component.
interface MediaRevisionValue {
  rev: number;
  bump: () => void;
}

const MediaRevisionContext = createContext<MediaRevisionValue>({ rev: 0, bump: () => {} });

export function MediaRevisionProvider({ children }: { children: ReactNode }) {
  const [rev, setRev] = useState(0);
  const bump = useCallback(() => setRev((n) => n + 1), []);
  const value = useMemo(() => ({ rev, bump }), [rev, bump]);
  return <MediaRevisionContext.Provider value={value}>{children}</MediaRevisionContext.Provider>;
}

export function useMediaRevision() {
  return useContext(MediaRevisionContext);
}
