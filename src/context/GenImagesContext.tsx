import { createContext, useContext } from 'react';
import type { ClipType } from '../types/gen';

// One entry in the gen-area (生图区) image list. Ordinal numbers (Image1/2/3)
// are derived live from the position of each item in this ordered array, so a
// single material dragged in twice occupies two slots with two ordinals.
export interface GenImageItem {
  id: string;        // stable per-slot id (a material may occupy several slots)
  mediaId: number;   // source material id
  name: string;      // material file name (may include extension)
  thumb: string;
  path: string;      // real filesystem path, for native file-list clipboard copy
  meta: string;      // duration / size label shown under the name
  type: ClipType;
}

interface GenImagesValue {
  images: GenImageItem[];
}

const GenImagesContext = createContext<GenImagesValue>({ images: [] });

export function useGenImages() {
  return useContext(GenImagesContext);
}

export const GenImagesProvider = GenImagesContext.Provider;

// Ordinal (1-based) of a slot within the current list, or null if the slot is gone.
export function ordinalOf(images: GenImageItem[], slotId: string): number | null {
  const idx = images.findIndex((it) => it.id === slotId);
  return idx < 0 ? null : idx + 1;
}

// File name without extension, for 'name' display mode.
export function baseName(name: string): string {
  return name.replace(/\.[^/.]+$/, '');
}
