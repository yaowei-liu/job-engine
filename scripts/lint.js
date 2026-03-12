#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const JS_DIRS = ['src', 'test', 'scripts'];
const JSON_FILES = [
  'package.json',
  'config/profile.json',
  'config/search.json',
  'config/sources.json',
  'src/lib/rules.default.json',
];

function collectFiles(dir, extension, out = []) {
  if (!fs.existsSync(dir)) return out;

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(fullPath, extension, out);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(extension)) {
      out.push(fullPath);
    }
  }

  return out;
}

function checkJavaScript(file) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: ROOT,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `Syntax check failed: ${file}\n`);
    process.exitCode = 1;
    return false;
  }

  return true;
}

function checkJson(file) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    return true;
  } catch (error) {
    process.stderr.write(`Invalid JSON in ${file}: ${error.message}\n`);
    process.exitCode = 1;
    return false;
  }
}

const jsFiles = JS_DIRS.flatMap((dir) => collectFiles(path.join(ROOT, dir), '.js')).sort();

let checked = 0;

for (const file of jsFiles) {
  if (checkJavaScript(file)) checked += 1;
}

for (const file of JSON_FILES) {
  if (checkJson(file)) checked += 1;
}

if (process.exitCode) {
  process.exit(process.exitCode);
}

process.stdout.write(`Lint passed for ${checked} files.\n`);
