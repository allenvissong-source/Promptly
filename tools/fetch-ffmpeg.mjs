#!/usr/bin/env node
/**
 * Fetch the ffmpeg binary that gets bundled into the app as a Tauri sidecar.
 *
 * Tauri's `externalBin` requires the file to be named `<name>-<target-triple>`,
 * e.g. `ffmpeg-aarch64-apple-darwin` / `ffmpeg-x86_64-pc-windows-msvc.exe`, and
 * to live next to `tauri.conf.json` under the path given in the config
 * (`binaries/ffmpeg` -> `src-tauri/binaries/ffmpeg-<triple>`).
 *
 * Run this once per machine/architecture before `npm run tauri build`; the
 * `pretauri:build` hook in package.json does it automatically. The downloaded
 * binaries are gitignored (~65 MB each) so they never enter version control.
 *
 * Notes:
 * - We deliberately do NOT `strip` the binary: on macOS that invalidates the
 *   upstream Developer ID signature and would make Gatekeeper complain.
 * - Only `ffmpeg` is needed. Duration and codec detection parse the stderr of
 *   `ffmpeg -i`, so there is no ffprobe dependency.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const binariesDir = path.join(projectRoot, 'src-tauri', 'binaries');

// Minimum plausible size for a real ffmpeg build; guards against HTML error
// pages or truncated downloads being mistaken for a binary.
const MIN_ZIP_BYTES = 1_000_000;
const MIN_BIN_BYTES = 5_000_000;

function log(msg) {
  process.stdout.write(`[fetch-ffmpeg] ${msg}\n`);
}

function fail(msg) {
  process.stderr.write(`[fetch-ffmpeg] ERROR: ${msg}\n`);
  process.exit(1);
}

/** Resolve the Rust host target triple, which names the sidecar file. */
function hostTriple() {
  try {
    const out = execSync('rustc --print host-tuple', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (out) return out;
  } catch {
    // rustc < 1.84 has no --print host-tuple; fall through to -Vv parsing.
  }
  try {
    const vv = execSync('rustc -Vv', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = vv.split('\n').find((l) => l.startsWith('host:'));
    if (line) return line.slice('host:'.length).trim();
  } catch {
    // ignore
  }
  fail('could not determine the Rust host target triple; is rustc installed?');
}

/**
 * Download mirrors per platform, tried in order.
 *
 * The previous in-app downloader used `darwin/arm64` for Apple Silicon, which
 * is a 404 — the upstream site uses `macos/arm64`. That single typo is why
 * every M-series user hit "自动下载 ffmpeg 失败". Bundling removes the runtime
 * dependency entirely, and these URLs are now only exercised at build time on
 * the developer's machine.
 */
function mirrorsFor(triple) {
  if (triple.includes('apple-darwin')) {
    const arm = triple.startsWith('aarch64');
    return arm
      ? [
          'https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip',
          'https://www.osxexperts.net/ffmpeg81arm.zip',
          'https://evermeet.cx/ffmpeg/getrelease/zip',
        ]
      : [
          'https://ffmpeg.martin-riedl.de/redirect/latest/macos/amd64/release/ffmpeg.zip',
          'https://evermeet.cx/ffmpeg/getrelease/zip',
        ];
  }
  if (triple.includes('windows')) {
    return [
      'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      'https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
      'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
    ];
  }
  if (triple.includes('linux')) {
    const arm = triple.startsWith('aarch64');
    return [
      `https://ffmpeg.martin-riedl.de/redirect/latest/linux/${arm ? 'arm64' : 'amd64'}/release/ffmpeg.zip`,
    ];
  }
  fail(`unsupported target triple: ${triple}`);
}

function download(url, dest) {
  fs.rmSync(dest, { force: true });
  execSync(
    `curl -sSL --fail --retry 2 --max-time 900 -o ${JSON.stringify(dest)} ${JSON.stringify(url)}`,
    { stdio: ['ignore', 'inherit', 'inherit'] }
  );
  const size = fs.statSync(dest).size;
  if (size < MIN_ZIP_BYTES) {
    throw new Error(`downloaded archive is suspiciously small (${size} bytes)`);
  }
  return size;
}

/**
 * Extract just the ffmpeg executable out of the archive. Windows builds nest it
 * under <folder>/bin/ffmpeg.exe; the macOS builds ship a bare `ffmpeg`.
 */
function extract(zipPath, destBin, isWindows) {
  const want = isWindows ? 'ffmpeg.exe' : 'ffmpeg';
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'ffmpeg-extract-'));
  try {
    execSync(`unzip -qo ${JSON.stringify(zipPath)} -d ${JSON.stringify(staging)}`, {
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    const found = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name === want) found.push(full);
      }
    };
    walk(staging);
    if (found.length === 0) throw new Error(`'${want}' not found inside the archive`);
    // Prefer the largest match, guarding against stub/wrapper files.
    found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
    const src = found[0];
    const size = fs.statSync(src).size;
    if (size < MIN_BIN_BYTES) {
      throw new Error(`extracted binary is suspiciously small (${size} bytes)`);
    }
    fs.mkdirSync(path.dirname(destBin), { recursive: true });
    fs.copyFileSync(src, destBin);
    if (process.platform !== 'win32') fs.chmodSync(destBin, 0o755);
    return size;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  const force = process.argv.includes('--force');
  const triple = hostTriple();
  const isWindows = triple.includes('windows');
  const ext = isWindows ? '.exe' : '';
  const destBin = path.join(binariesDir, `ffmpeg-${triple}${ext}`);

  if (fs.existsSync(destBin) && !force) {
    const mb = (fs.statSync(destBin).size / 1024 / 1024).toFixed(1);
    log(`already present (${mb} MB): ${path.relative(projectRoot, destBin)}`);
    log('pass --force to re-download.');
    return;
  }

  fs.mkdirSync(binariesDir, { recursive: true });
  const tmpZip = path.join(binariesDir, `.ffmpeg-download-${process.pid}.zip`);
  const mirrors = mirrorsFor(triple);
  let lastErr = 'no mirrors attempted';

  for (const url of mirrors) {
    try {
      log(`downloading ${url}`);
      const zipSize = download(url, tmpZip);
      log(`got ${(zipSize / 1024 / 1024).toFixed(1)} MB, extracting...`);
      const binSize = extract(tmpZip, destBin, isWindows);
      fs.rmSync(tmpZip, { force: true });
      log(`ready (${(binSize / 1024 / 1024).toFixed(1)} MB): ${path.relative(projectRoot, destBin)}`);

      // Sanity check: the binary must actually run on this host.
      try {
        const v = execSync(`${JSON.stringify(destBin)} -hide_banner -version`, {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .split('\n')[0]
          .trim();
        log(`verified: ${v}`);
      } catch {
        log('WARNING: could not run the binary on this host (cross-build?); continuing.');
      }
      return;
    } catch (err) {
      lastErr = err && err.message ? err.message : String(err);
      log(`mirror failed: ${lastErr}`);
      fs.rmSync(tmpZip, { force: true });
    }
  }
  fail(`all mirrors failed. last error: ${lastErr}`);
}

main();
