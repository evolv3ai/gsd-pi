#!/usr/bin/env node
const { mkdirSync, cpSync } = require('fs');
const { resolve } = require('path');
const src = resolve(__dirname, '..', 'packages', 'pi-coding-agent', 'dist', 'theme');
mkdirSync('pkg/dist/theme', { recursive: true });
cpSync(src, 'pkg/dist/theme', { recursive: true });
