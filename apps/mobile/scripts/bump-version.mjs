#!/usr/bin/env node
// bump-version.mjs — bump SemVer in apps/mobile/package.json.
//
// Usage:
//   node scripts/bump-version.mjs patch    # 1.0.0 -> 1.0.1
//   node scripts/bump-version.mjs minor    # 1.0.0 -> 1.1.0
//   node scripts/bump-version.mjs major    # 1.0.0 -> 2.0.0
//
// app.config.ts imports `version` from this file's package.json, so bumping
// here is the single source of truth. With runtimeVersion policy
// "appVersion", this also changes the EAS Update runtime version — an
// `eas update` published against the new version only reaches builds
// compiled at that version. If the change being released touches native
// code (new module, config-plugin, permission, SDK bump), a fresh
// `eas build` is required at the new version; JS-only changes can ship via
// `eas update` alone. Android versionCode / iOS buildNumber are NOT touched
// here — eas.json's `appVersionSource: "remote"` + production
// `autoIncrement` manage those remotely.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(__dirname, '..', 'package.json');

const kind = process.argv[2];
if (!['patch', 'minor', 'major'].includes(kind)) {
  console.error('Usage: bump-version.mjs <patch|minor|major>');
  process.exit(1);
}

function bump(version, kind) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`Cannot parse semver: ${version}`);
  let [, major, minor, patch] = m.map(Number);
  if (kind === 'major') { major += 1; minor = 0; patch = 0; }
  else if (kind === 'minor') { minor += 1; patch = 0; }
  else { patch += 1; }
  return `${major}.${minor}.${patch}`;
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const oldVersion = pkg.version;
const newVersion = bump(oldVersion, kind);
pkg.version = newVersion;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`apps/mobile/package.json: ${oldVersion} → ${newVersion}`);
console.log('This changes the EAS Update runtimeVersion (policy: appVersion).');
console.log('If this release includes native changes, rebuild with:');
console.log('  pnpm --filter @cafe-mgmt/mobile build:apk');
console.log('Commit with:');
console.log(`  git commit -am "chore(mobile): bump version to ${newVersion}"`);
