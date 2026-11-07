#!/usr/bin/env node
/**
 * Generates every icon / splash PNG in apps/mobile/assets from one vector glyph — a terminal
 * prompt (`>_`) in the app's accent on the theme background — so the artwork stays consistent
 * across iOS (light / dark / tinted), Android (adaptive + monochrome), the splash screens, the
 * Android notification icon, the favicon and the PWA icons.
 *
 *   node assets/icon-source/build-icons.mjs            # from apps/mobile
 *   node assets/icon-source/build-icons.mjs --only icon.png,favicon.png
 *
 * Rasteriser (first that works):
 *   1. `sharp`, when it is resolvable from apps/mobile
 *   2. headless Chromium through playwright-core:
 *        PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core   (default: resolve from cwd)
 *        CHROME_PATH=/path/to/chrome-or-headless-shell            (optional; Playwright's own download otherwise)
 *
 * The PWA icons land in assets/web/; copy them over apps/mobile/public/ when you change the glyph
 * (the daemon serves public/ as-is).
 */
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(HERE, '..');

// Theme tokens (keep in sync with src/theme/palette.ts)
const DARK_BG = '#121311';
const ACCENT_DARK = '#e9ad52';
const ACCENT_LIGHT = '#96601b';
const WHITE = '#ffffff';

/**
 * The glyph lives in a 1024×1024 box, visually centred: a chevron and an underscore cursor.
 * Stroke 112 with round caps reads well from 96 px (notification) to 1024 px (App Store).
 */
function glyph(fg, scale = 1) {
  return `<g transform="translate(512 512) scale(${scale}) translate(-512 -512)" fill="none" stroke="${fg}" stroke-width="112" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="291,332 507,512 291,692" />
    <line x1="559" y1="692" x2="733" y2="692" />
  </g>`;
}

function svg({ size, bg, fg, scale = 1, radius = 0 }) {
  const rect = bg ? `<rect width="1024" height="1024" rx="${radius}" ry="${radius}" fill="${bg}" />` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 1024 1024">${rect}${glyph(fg, scale)}</svg>`;
}

/** Every artefact app.json / public/ refers to. */
const TARGETS = [
  // iOS: light icon is opaque; dark and tinted variants must be transparent (the system supplies the background)
  { file: 'icon.png', size: 1024, bg: DARK_BG, fg: ACCENT_DARK },
  { file: 'icon-dark.png', size: 1024, bg: null, fg: ACCENT_DARK },
  { file: 'icon-tinted.png', size: 1024, bg: null, fg: WHITE },
  // Android adaptive icon: foreground inside the 66 % safe zone; monochrome for themed icons
  { file: 'adaptive-icon.png', size: 1024, bg: null, fg: ACCENT_DARK, scale: 0.62 },
  { file: 'adaptive-icon-mono.png', size: 1024, bg: null, fg: WHITE, scale: 0.62 },
  // Splash (expo-splash-screen, resizeMode contain): light and dark variants
  { file: 'splash-icon.png', size: 1024, bg: null, fg: ACCENT_LIGHT },
  { file: 'splash-icon-dark.png', size: 1024, bg: null, fg: ACCENT_DARK },
  // Android notification small icon: white on transparent
  { file: 'notification-icon.png', size: 96, bg: null, fg: WHITE },
  // Web favicon (Expo turns it into favicon.ico)
  { file: 'favicon.png', size: 256, bg: DARK_BG, fg: ACCENT_DARK, radius: 200 },
  // PWA icons → copy to apps/mobile/public/
  { file: 'web/apple-touch-icon.png', size: 180, bg: DARK_BG, fg: ACCENT_DARK },
  { file: 'web/icon-192.png', size: 192, bg: DARK_BG, fg: ACCENT_DARK },
  { file: 'web/icon-512.png', size: 512, bg: DARK_BG, fg: ACCENT_DARK },
  { file: 'web/icon-512-maskable.png', size: 512, bg: DARK_BG, fg: ACCENT_DARK, scale: 0.72 },
];

function parseArgs(argv) {
  const out = { only: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only' && argv[i + 1]) out.only = new Set(argv[++i].split(',').map((s) => s.trim()));
  }
  return out;
}

async function withSharp() {
  let sharp;
  try {
    sharp = require('sharp');
  } catch {
    return null;
  }
  return {
    name: 'sharp',
    async render(markup, size) {
      return sharp(Buffer.from(markup), { density: 72 }).resize(size, size).png().toBuffer();
    },
    async close() {},
  };
}

async function withChromium() {
  let pw;
  const candidates = [process.env.PLAYWRIGHT_CORE, 'playwright-core', 'playwright'].filter(Boolean);
  for (const c of candidates) {
    try {
      pw = require(c);
      break;
    } catch {
      /* try next */
    }
  }
  if (!pw) return null;
  const launch = { headless: true };
  if (process.env.CHROME_PATH) launch.executablePath = process.env.CHROME_PATH;
  const browser = await pw.chromium.launch(launch);
  const context = await browser.newContext({ deviceScaleFactor: 1, colorScheme: 'dark' });
  const page = await context.newPage();
  return {
    name: 'chromium',
    async render(markup, size) {
      await page.setViewportSize({ width: size, height: size });
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}svg{display:block}</style></head><body>${markup}</body></html>`,
        { waitUntil: 'load' },
      );
      return page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    },
    async close() {
      await browser.close();
    },
  };
}

async function main() {
  const { only } = parseArgs(process.argv.slice(2));
  const raster = (await withSharp()) ?? (await withChromium());
  if (!raster) {
    console.error(
      'No rasteriser available: install `sharp`, or set PLAYWRIGHT_CORE to a playwright-core install (and CHROME_PATH to a Chromium binary).',
    );
    process.exit(1);
  }
  console.log(`rasteriser: ${raster.name}`);
  try {
    for (const target of TARGETS) {
      if (only && !only.has(target.file)) continue;
      const out = path.join(ASSETS, target.file);
      await fs.mkdir(path.dirname(out), { recursive: true });
      const png = await raster.render(svg(target), target.size);
      await fs.writeFile(out, png);
      console.log(
        `  ${target.file.padEnd(28)} ${String(target.size).padStart(4)}px  ${target.bg ? 'opaque' : 'transparent'}  ${(png.length / 1024).toFixed(1)} KB`,
      );
    }
  } finally {
    await raster.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
