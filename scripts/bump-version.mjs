#!/usr/bin/env node
// bump-version.mjs — bump SemVer in lockstep across package.json files.
//
// Usage:
//   node scripts/bump-version.mjs patch    # 1.1.0 -> 1.1.1
//   node scripts/bump-version.mjs minor    # 1.1.0 -> 1.2.0
//   node scripts/bump-version.mjs major    # 1.1.0 -> 2.0.0
//
// Files kept in sync:
//   - package.json           (monorepo root, metadata only)
//   - apps/web/package.json  (read by vite.config.ts → injected into the bundle)
//
// We deliberately do NOT touch the Go binary version — backend deploys are
// tagged by git SHA already, and a separate semver there would drift.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const kind = process.argv[2];
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Usage: bump-version.mjs <patch|minor|major>');
  process.exit(1);
}

const FILES = [
  resolve(root, 'package.json'),
  resolve(root, 'apps/web/package.json'),
];

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Cannot parse semver: ${version}`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${major}.${minor}.${patch}`;
}

// Read the current version from the root — that's the source of truth.
const rootPkg = JSON.parse(readFileSync(FILES[0], 'utf8'));
const oldVersion = rootPkg.version;
const newVersion = bump(oldVersion, kind);

for (const path of FILES) {
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  pkg.version = newVersion;
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`  ${path.replace(root + '/', '')}: ${oldVersion} → ${newVersion}`);
}

console.log(`\nBumped ${kind}: ${oldVersion} → ${newVersion}`);
console.log('Commit with:');
console.log(`  git commit -am "chore: bump version to ${newVersion}"`);
