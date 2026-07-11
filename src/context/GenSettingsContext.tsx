import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import type { ReactNode } from 'react';

// How @ chips in the gen-area (生图区) text box are displayed.
//  - 'code': the derived ordinal, e.g. "Image1" / "Image2" (order-driven)
//  - 'name': the material file name without extension
// Neither mode keeps the leading "@".
export type ChipMode = 'code' | 'name';

const CHIP_MODE_KEY = 'promptly.chipMode';

function readInitialChipMode(): ChipMode {
  try {
    const v = localStorage.getItem(CHIP_MODE_KEY);
    if (v === 'code' || v === 'name') return v;
  } catch {
    // localStorage unavailable (e.g. SSR / privacy mode) — fall back below.
  }
  return 'code';
}

interface GenSettingsValue {
  chipMode: ChipMode;
  setChipMode: (mode: ChipMode) => void;
  toggleChipMode: () => void;
}

const GenSettingsContext = createContext<GenSettingsValue | null>(null);

export function useGenSettings() {
  const ctx = useContext(GenSettingsContext);
  if (!ctx) throw new Error('useGenSettings must be used within GenSettingsProvider');
  return ctx;
}

export function GenSettingsProvider({ children }: { children: ReactNode }) {
  const [chipMode, setChipMode] = useState<ChipMode>(readInitialChipMode);
  useEffect(() => {
    try {
      localStorage.setItem(CHIP_MODE_KEY, chipMode);
    } catch {
      // ignore persistence failures
    }
  }, [chipMode]);
  const toggleChipMode = useCallback(
    () => setChipMode((m) => (m === 'code' ? 'name' : 'code')),
    []
  );
  return (
    <GenSettingsContext.Provider value={{ chipMode, setChipMode, toggleChipMode }}>
      {children}
    </GenSettingsContext.Provider>
  );
}
