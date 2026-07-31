import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';

export type MediaVariant = 'path' | 'thumb' | 'preview';

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string>>();

function mimeFromName(name?: string | null): string {
  const ext = (name?.split('.').pop() ?? '').toLowerCase();
  if (['jpg', 'jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'webm') return 'video/webm';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg') return 'audio/ogg';
  return 'application/octet-stream';
}

function bytesToUint8Array(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) return new Uint8Array(data as number[]);
  if (data && typeof data === 'object' && 'buffer' in data) {
    const maybe = data as { buffer?: ArrayBuffer };
    if (maybe.buffer instanceof ArrayBuffer) return new Uint8Array(maybe.buffer);
  }
  return new Uint8Array();
}

export async function readMediaObjectUrl(
  mediaId: number,
  variant: MediaVariant = 'path',
  name?: string | null
): Promise<string> {
  const key = `${mediaId}:${variant}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const inFlight = pending.get(key);
  if (inFlight) return inFlight;
  const promise = invoke<unknown>('read_media', { mediaId, variant })
    .then((bytes) => {
      const view = bytesToUint8Array(bytes);
      const body = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
      const blob = new Blob([body], { type: mimeFromName(name) });
      const url = URL.createObjectURL(blob);
      cache.set(key, url);
      pending.delete(key);
      return url;
    })
    .catch((err) => {
      pending.delete(key);
      throw err;
    });
  pending.set(key, promise);
  return promise;
}

export function useMediaObjectUrl(
  mediaId: number | null | undefined,
  variant: MediaVariant = 'path',
  name?: string | null,
  fallback = ''
): string {
  const key = mediaId == null ? 'empty' : `${mediaId}:${variant}:${name ?? ''}:${fallback}`;
  const [state, setState] = useState(() => ({ key, url: fallback }));
  const url = state.key === key ? state.url : fallback;

  useEffect(() => {
    let cancelled = false;
    if (mediaId == null) return () => {
      cancelled = true;
    };
    readMediaObjectUrl(mediaId, variant, name)
      .then((next) => {
        if (!cancelled) setState({ key, url: next });
      })
      .catch((err) => {
        console.error('Failed to read media', err);
        if (!cancelled) setState({ key, url: fallback });
      });
    return () => {
      cancelled = true;
    };
  }, [mediaId, variant, name, fallback, key]);

  return url;
}
