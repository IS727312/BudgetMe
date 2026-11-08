import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../server.mjs';

export const REPOSITORY = join(ROOT, '..');
export const SOURCE_PATHS = Object.freeze([
  '.gitattributes', '.gitignore', '.github/agents/security-agent.agent.md',
  '.github/agents/test-agent.agent.md', 'Launch BudgetMe.cmd', 'README.md', 'launch.ps1',
  'app/README.md', 'app/package.json', 'app/server.mjs',
  'app/lib/access.mjs', 'app/lib/finance.mjs', 'app/lib/startup.mjs', 'app/lib/vault.mjs',
  'app/public/app.js', 'app/public/favicon.svg', 'app/public/index.html', 'app/public/style.css',
  'app/test/access.test.mjs', 'app/test/finance.test.mjs', 'app/test/launcher.test.mjs',
  'app/test/server.test.mjs', 'app/test/source-control.test.mjs', 'app/test/vault.test.mjs',
  'app/tools/browser-check.mjs', 'app/tools/browser-driver.js', 'app/tools/fingerprint.mjs',
  'app/tools/launch.mjs', 'app/tools/record-review.mjs', 'app/tools/release-gate.mjs',
  'app/tools/restore.mjs', 'app/tools/restore-confirm.mjs', 'app/tools/source-control.mjs'
].sort());
const allowed = new Set(SOURCE_PATHS);

export function assertAllowedPaths(paths) {
  for (const path of paths) assert.ok(allowed.has(path), `Unapproved Git path; do not read or publish it: ${path}`);
}
export async function sourcePath(path) {
  assertAllowedPaths([path]);
  let current = REPOSITORY;
  for (const part of path.split('/')) {
    current = join(current, part);
    assert.ok(!(await lstat(current)).isSymbolicLink(), 'Source symlinks are not permitted.');
  }
  assert.ok((await lstat(current)).isFile(), 'Expected a regular source file.');
  return current;
}
export async function sourceBytes(path) {
  const bytes = await readFile(await sourcePath(path));
  if (!path.endsWith('.cmd')) return bytes;
  const text = bytes.toString('utf8');
  assert.ok(Buffer.from(text).equals(bytes), 'CMD source must be valid UTF-8.');
  assert.ok(!/(?<!\r)\n|\r(?!\n)/.test(text), 'CMD launchers require CRLF working-tree line endings.');
  return Buffer.from(text.replaceAll('\r\n', '\n'));
}
export function git(args, options = {}) {
  const result = spawnSync('git', ['-c', 'core.hooksPath=NUL', ...args], {
    cwd: REPOSITORY, ...options, env: {
      ...process.env, GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', ...options.env
    }
  });
  if (result.status !== 0) throw new Error(`Git source gate failed: ${args[0]} (${result.status}).`);
  return result.stdout;
}
export async function assertSourceIndex({ complete = false } = {}) {
  const entries = git(['ls-files', '--stage', '-z']).toString().split('\0').filter(Boolean).map(entry => {
    const match = /^(100644|100755) ([a-f0-9]+) 0\t(.+)$/.exec(entry);
    assert.ok(match, 'Unmerged, symlink or unsupported Git index entry.');
    return { hash: match[2], path: match[3] };
  });
  assertAllowedPaths(entries.map(entry => entry.path));
  assertAllowedPaths(git(['diff', '--cached', '--name-only', '-z']).toString().split('\0').filter(Boolean));
  if (complete) assert.deepEqual(entries.map(entry => entry.path).sort(), [...SOURCE_PATHS]);
  // Validate all index paths before accessing any blob; private tracked data is never read.
  for (const entry of entries) {
    const bytes = await sourceBytes(entry.path);
    assert.ok(git(['cat-file', 'blob', entry.hash]).equals(bytes), `Staged bytes differ from reviewed source: ${entry.path}`);
  }
  return entries.length;
}
