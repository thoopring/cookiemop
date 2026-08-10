// Build the Chrome Web Store package.
//
// The point of this script is the guard: it refuses to produce a zip while
// src/lib/config.js still holds placeholder URLs. Shipping a build whose
// "Get Pro" button points at a dead link is the kind of mistake that is
// cheap to prevent here and expensive to fix after review.
//
// Usage: node tools/package.mjs

import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = ['manifest.json', 'icons', 'src', '_locales', 'LICENSE'];

function fail(message, detail) {
  console.error(`\nPACKAGING BLOCKED: ${message}`);
  if (detail) console.error(detail);
  console.error('');
  process.exit(1);
}

// --- Guard 1: no placeholder URLs -----------------------------------------

const configPath = join(repoRoot, 'src', 'lib', 'config.js');
const configSource = readFileSync(configPath, 'utf8');

function readConstant(name) {
  const match = configSource.match(new RegExp(`export const ${name} = '([^']*)'`));
  if (!match) fail(`could not find ${name} in src/lib/config.js`);
  return match[1];
}

const placeholderMatch = configSource.match(/export const PLACEHOLDER_PATTERN = (\/.*\/);/);
if (!placeholderMatch) fail('could not find PLACEHOLDER_PATTERN in src/lib/config.js');
const placeholder = new RegExp(
  placeholderMatch[1].slice(1, placeholderMatch[1].lastIndexOf('/')),
  placeholderMatch[1].slice(placeholderMatch[1].lastIndexOf('/') + 1)
);

const urls = {
  CHECKOUT_URL: readConstant('CHECKOUT_URL'),
  LICENSE_LOOKUP_URL: readConstant('LICENSE_LOOKUP_URL')
};

const stillPlaceholder = Object.entries(urls).filter(([, value]) => placeholder.test(value));
if (stillPlaceholder.length) {
  fail(
    'src/lib/config.js still contains placeholder URLs.',
    stillPlaceholder.map(([name, value]) => `  ${name} = ${value}`).join('\n') +
      '\n\nReplace them with the deployed Lemon Squeezy checkout and /license URLs,\n' +
      'then run this again. See docs/SUBMIT_CHECKLIST.md.'
  );
}
for (const [name, value] of Object.entries(urls)) {
  if (!/^https:\/\//.test(value)) fail(`${name} must be an https URL, got: ${value}`);
}

// --- Guard 2: no network primitives in shipped code -----------------------

const NETWORK_PATTERN =
  /\bfetch\s*\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|importScripts/;
function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

const offenders = walk(join(repoRoot, 'src'))
  .filter((file) => /\.(js|html)$/.test(file))
  .filter((file) => NETWORK_PATTERN.test(readFileSync(file, 'utf8')));
if (offenders.length) {
  fail(
    'a network primitive appears in the shipped extension source.',
    offenders.map((f) => '  ' + f.replace(repoRoot, '.')).join('\n')
  );
}

// --- Guard 3: manifest version matches the package name -------------------

const manifest = JSON.parse(readFileSync(join(repoRoot, 'manifest.json'), 'utf8'));
const version = manifest.version;
if (!/^\d+\.\d+\.\d+$/.test(version)) fail(`manifest version looks wrong: ${version}`);

// --- Build ----------------------------------------------------------------

mkdirSync(join(repoRoot, 'dist'), { recursive: true });
const zipPath = join(repoRoot, 'dist', `cookiemop-${version}.zip`);

// PowerShell's Compress-Archive is always present on Windows and needs no
// dependency. The explicit file list is what keeps server/, tools/, docs/
// and tests/ out of the store build.
execFileSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    `if (Test-Path '${zipPath}') { Remove-Item '${zipPath}' }; ` +
      `Compress-Archive -Path ${SHIPPED.join(', ')} -DestinationPath '${zipPath}'`
  ],
  { cwd: repoRoot, stdio: 'inherit' }
);

const size = statSync(zipPath).size;
console.log(`\nPackaged ${zipPath}`);
console.log(`  version ${version}, ${(size / 1024).toFixed(1)} KB`);
console.log(`  CHECKOUT_URL        ${urls.CHECKOUT_URL}`);
console.log(`  LICENSE_LOOKUP_URL  ${urls.LICENSE_LOOKUP_URL}`);
console.log('  guards passed: no placeholder URLs, no network primitives in src/\n');
