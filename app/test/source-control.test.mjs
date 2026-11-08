import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SOURCE_PATHS, assertAllowedPaths, sourcePath, git, assertSourceIndex } from '../tools/source-control.mjs';

test('source allowlist rejects private paths before any content access', () => {
  assertAllowedPaths(SOURCE_PATHS);
  for (const path of ['app/data/vault.json', 'app/exports/report.xml', '.runtime/token',
    'app/.runtime/release/security.json', 'app/private.json', 'app/lib/key.pem',
    '.env', '../outside', '/absolute', 'app/public/browser-profile/state']) {
    assert.throws(() => assertAllowedPaths([path]), /Unapproved Git path/);
  }
});
test('default-deny ignores cover existing and future private path metadata', () => {
  const paths = ['app/data/vault.json', 'app/data/process.lock', 'app/exports/report.xml',
    '.runtime/home/profile', 'app/.runtime/release/security.json', 'app/.env',
    'app/new-backup.bin', 'app/new-cache/output.json', 'app/lib/key.pem',
    'app/public/screenshot.png', 'credentials.json', 'app/test/financial-fixture.json'];
  const result = git(['check-ignore', '--no-index', '-z', '--stdin'], { input: `${paths.join('\0')}\0` })
    .toString().split('\0').filter(Boolean);
  assert.deepEqual(result, paths);
});
test('index uses approved canonical source bytes and native CMD line endings', async () => {
  await assertSourceIndex();
  for (const path of SOURCE_PATHS) {
    const source = await readFile(await sourcePath(path), 'utf8');
    if (path.endsWith('.cmd')) assert.ok(!/(?<!\r)\n|\r(?!\n)/.test(source), 'CMD requires CRLF.');
    else assert.ok(!source.includes('\r'), `Non-reproducible line endings: ${path}`);
    assert.ok(!/C:\\Users\\/i.test(source), `Personal absolute path in public source: ${path}`);
  }
});
