#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BACKUP_DIR = path.join(ROOT, '.prepack-backup');

function restoreDir(currentDir, relativeDir = '') {
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const relPath = relativeDir ? path.join(relativeDir, entry.name) : entry.name;
    const sourcePath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      restoreDir(sourcePath, relPath);
      continue;
    }
    const targetPath = path.join(ROOT, relPath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(sourcePath, targetPath);
    console.log(`[postpack] Restored ${relPath}`);
  }
}

if (!fs.existsSync(BACKUP_DIR)) {
  process.exit(0);
}

restoreDir(BACKUP_DIR);
fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
console.log('[postpack] Restored workspace:* internal dependency ranges');
