// Rasterizes brand/verlox-icon.svg into the icon assets electron-builder
// needs: build/icon.ico (Windows, multi-resolution) and build/icon.png
// (512px base for macOS/Linux). Run via `npm run make-icons` before a
// packaged build. sharp renders the SVG (gradients + rounded corners and
// all) at high density, then downsamples for crisp small sizes.
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const svg = readFileSync(resolve(root, 'brand/verlox-icon.svg'));
const buildDir = resolve(root, 'build');
mkdirSync(buildDir, { recursive: true });

// density 384 = supersample the 512px SVG before downscaling, so 16/32px
// icons stay sharp instead of muddy.
const render = (size) =>
  sharp(svg, { density: 384 }).resize(size, size).png().toBuffer();

const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const buffers = [];
for (const size of icoSizes) buffers.push(await render(size));

const ico = await pngToIco(buffers);
writeFileSync(resolve(buildDir, 'icon.ico'), ico);

await sharp(svg, { density: 384 })
  .resize(512, 512)
  .png()
  .toFile(resolve(buildDir, 'icon.png'));

console.log('icons written: build/icon.ico, build/icon.png');
