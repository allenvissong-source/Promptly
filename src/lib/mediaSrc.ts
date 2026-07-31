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

/**
 * MIME type for the blob we hand to `<img>` / `<video>`.
 *
 * `name` is the media's own file name, which describes the 'path' variant only.
 * The derived variants are different formats:
 *   - 'thumb'   -> a JPEG produced by ffmpeg (<path>.thumb.jpg), except for
 *                  images, where the thumb IS the original file.
 *   - 'preview' -> an H.264 MP4 (<path>.preview.mp4).
 *
 * Typing a video's cover as `video/mp4` (what naming alone implies) makes
 * `<img>` refuse to render it and show the broken-image placeholder, even
 * though ffmpeg extracted the frame correctly.
 */
function mimeForVariant(variant: MediaVariant, name?: string | null): string {
  if (variant === 'preview') return 'video/mp4';
  if (variant === 'thumb') {
    const mime = mimeFromName(name);
    // Image thumbs reuse the source file, so keep its real type (png/gif/webp/
    // svg all matter here). Everything else got a JPEG cover from ffmpeg.
    return mime.startsWith('image/') ? mime : 'image/jpeg';
  }
  return mimeFromName(name);
}

function bytesToUint8Array(data: unknown): Uint8Array {
  // 1. Plain ArrayBuffer
  if (data instanceof ArrayBuffer) return new Uint8Array(data);

  // 2. Already a Uint8Array (or any typed array view)
  if (data instanceof Uint8Array) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    // Other typed arrays (Int8Array, Uint16Array, etc.) — copy the bytes
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  // 3. Plain number array (serde_json default for Vec<u8>)
  if (Array.isArray(data)) return new Uint8Array(data as number[]);

  // 4. Object with a .buffer property (typed-array-like, e.g. from postMessage)
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (d.buffer instanceof ArrayBuffer) {
      const offset = typeof d.byteOffset === 'number' ? d.byteOffset : 0;
      const length = typeof d.byteLength === 'number' ? d.byteLength : (d.buffer as ArrayBuffer).byteLength;
      return new Uint8Array(d.buffer as ArrayBuffer, offset, length);
    }
    // 5. Node.js-style Buffer: { type: 'Buffer', data: [..] }
    if (d.type === 'Buffer' && Array.isArray(d.data)) {
      return new Uint8Array(d.data as number[]);
    }
    // 6. Array-like with numeric indices and byteLength
    if (typeof d.byteLength === 'number' && d.byteLength >= 0) {
      const out = new Uint8Array(d.byteLength as number);
      for (let i = 0; i < out.length; i++) {
        const v = (d as Record<string, unknown>)[String(i)];
        out[i] = typeof v === 'number' ? v & 0xff : 0;
      }
      return out;
    }
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
      const blob = new Blob([body], { type: mimeForVariant(variant, name) });
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
