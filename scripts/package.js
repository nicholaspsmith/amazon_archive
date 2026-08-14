#!/usr/bin/env node
// Builds installable archives from extension/.
//
// The one thing that matters here: manifest.json must sit at the ROOT of the
// archive. Compressing the extension folder itself — which is what Finder's
// "Compress" and `zip -r ext.zip extension` both do — nests everything under
// an `extension/` directory, and Firefox reports the result as "corrupt"
// because it finds no manifest at the top level. Zipping from *inside* the
// directory is what avoids that.

import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'extension');
const dist = join(root, 'dist');

const { version } = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));

// macOS metadata is noise in a cross-platform archive and, in the case of
// __MACOSX, an entry Firefox has to skip past.
const EXCLUDES = ['.DS_Store', '__MACOSX/*', '*/.DS_Store'];

mkdirSync(dist, { recursive: true });

function build(filename) {
  const target = join(dist, filename);
  rmSync(target, { force: true });
  // `cwd: source` is load-bearing — see the note at the top of this file.
  execFileSync('zip', ['-qr', '-X', target, '.', '-x', ...EXCLUDES], { cwd: source });
  return target;
}

const firefox = build(`amazon-order-hider-${version}.xpi`);
const chrome = build(`amazon-order-hider-${version}-chrome.zip`);

// Verify rather than assume: a bad archive is the exact bug this script exists
// to prevent, so fail loudly instead of shipping one.
for (const artifact of [firefox, chrome]) {
  const listing = execFileSync('unzip', ['-Z1', artifact], { encoding: 'utf8' })
    .split('\n').filter(Boolean);

  if (!listing.includes('manifest.json')) {
    console.error(`FAIL ${artifact}: manifest.json is not at the archive root.`);
    console.error(`  top-level entries: ${[...new Set(listing.map((p) => p.split('/')[0]))].join(', ')}`);
    process.exit(1);
  }
  if (listing.some((p) => p.startsWith('__MACOSX') || p.endsWith('.DS_Store'))) {
    console.error(`FAIL ${artifact}: macOS metadata leaked into the archive.`);
    process.exit(1);
  }
  console.log(`ok  ${artifact.replace(`${root}/`, '')}  (${listing.length} entries, manifest at root)`);
}

if (!existsSync(firefox)) process.exit(1);

console.log(`
Chrome   chrome://extensions -> Developer mode -> Load unpacked -> pick extension/
         (Chrome installs from the directory; the zip is only for distribution.)

Firefox / Zen
  test   about:debugging#/runtime/this-firefox -> Load Temporary Add-on
         -> pick extension/manifest.json   (unsigned, gone on restart)
  keep   npm run sign   -> installs permanently, requires AMO API credentials
`);
