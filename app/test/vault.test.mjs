import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ROOT } from '../server.mjs';
import { initialState } from '../lib/finance.mjs';
import { newKey, seal, unseal, unlock, VaultStore, atomicFile, acquireLock } from '../lib/vault.mjs';

const password = 'synthetic-only four unrelated words';
test('strong scrypt, encrypted roundtrip and all tamper surfaces fail closed', async () => {
  const { key, salt } = await newKey(password);
  try {
    const s = initialState('Synthetic private name'), encrypted = seal(s, key, salt);
    assert.ok(!encrypted.includes('Synthetic private name'));
    assert.deepEqual(unseal(encrypted, key), s);
    const unlocked = await unlock(encrypted, password); assert.deepEqual(unlocked.state, s); unlocked.key.fill(0);
    await assert.rejects(unlock(encrypted, 'wrong synthetic passphrase'));
    const e = JSON.parse(encrypted);
    assert.equal(e.header.kdf.N, 131072);
    for (const part of ['iv', 'tag', 'ciphertext']) {
      const copy = structuredClone(e), bytes = Buffer.from(copy[part], 'base64'); bytes[0] ^= 1; copy[part] = bytes.toString('base64');
      assert.throws(() => unseal(JSON.stringify(copy), key), part);
    }
    const changed = structuredClone(e); changed.header.kdf.N = 1073741824;
    await assert.rejects(unlock(JSON.stringify(changed), password));
    const changedSalt = structuredClone(e); changedSalt.header.salt = Buffer.alloc(32).toString('base64');
    assert.throws(() => unseal(JSON.stringify(changedSalt), key));
    assert.throws(() => unseal('not json', key)); assert.throws(() => unseal('x'.repeat(12_000_001), key));
    assert.notEqual(JSON.parse(seal(s, key, salt)).iv, e.iv);
  } finally { key.fill(0); }
});
test('password bounds and strong KDF work with explicit maxmem', async () => {
  for (const bad of ['', 'short', ' '.repeat(15), 'a'.repeat(129), 123]) await assert.rejects(newKey(bad));
  const { key } = await newKey(password); assert.equal(key.length, 32); key.fill(0);
});
test('atomic snapshots, injected write failures, bounded previous snapshot and persistence', async () => {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.runtime', 'vault-test-'));
  const { key, salt } = await newKey(password);
  try {
    const store = new VaultStore(dir), s = initialState('Synthetic first');
    assert.equal(await store.initialized(), false);
    await store.write(s, key, salt); const first = await store.read();
    for (const failure of ['before-backup', 'after-backup', 'before-replace']) {
      const broken = new VaultStore(dir, stage => { if (stage === failure) throw new Error('Synthetic injected disk failure'); });
      await assert.rejects(broken.write(initialState('Synthetic next'), key, salt));
      assert.equal(await store.read(), first);
      assert.ok(!(await readdir(dir)).some(n => n.endsWith('.tmp')));
    }
    await store.write(initialState('Synthetic next'), key, salt);
    assert.equal(unseal(await store.read(), key).profile.name, 'Synthetic next');
    assert.equal(await readFile(store.previous, 'utf8'), first);
    await rm(store.path);
    await assert.rejects(store.initialized(), /previous encrypted snapshot/);
  } finally { key.fill(0); await rm(dir, { recursive: true }); }
});
test('atomic file verification failure leaves existing target untouched', async () => {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.runtime', 'atomic-test-'));
  try {
    const path = join(dir, 'target'); await writeFile(path, 'old synthetic');
    await assert.rejects(atomicFile(path, 'new synthetic', () => { throw new Error('Synthetic verify failure'); }));
    assert.equal(await readFile(path, 'utf8'), 'old synthetic');
  } finally { await rm(dir, { recursive: true }); }
});
test('exclusive data ownership never steals live or ambiguous locks', async () => {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.runtime', 'lock-test-'));
  try {
    const release = await acquireLock(dir);
    await assert.rejects(acquireLock(dir), /locked/);
    assert.equal(JSON.parse(await readFile(join(dir, 'process.lock'), 'utf8')).pid, process.pid);
    await release();
    await writeFile(join(dir, 'process.lock'), '{"pid":99999999}');
    await assert.rejects(acquireLock(dir), /locked/);
  } finally { await rm(dir, { recursive: true }); }
});
test('abrupt process exit before replacement preserves current and requires explicit temp recovery', async () => {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.runtime', 'crash-test-'));
  const { key, salt } = await newKey(password);
  try {
    const store = new VaultStore(dir);
    await store.write(initialState('Synthetic before crash'), key, salt);
    const before = await store.read();
    const code = `
      import { VaultStore, newKey } from './lib/vault.mjs';
      import { initialState } from './lib/finance.mjs';
      const derived = await newKey('synthetic-only four unrelated words');
      const store = new VaultStore(${JSON.stringify(dir)}, stage => { if (stage === 'before-replace') process.exit(23); });
      await store.write(initialState('Synthetic crash candidate'), derived.key, derived.salt);
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
      cwd: ROOT, env: { ...process.env, TEMP: dir, TMP: dir, HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir },
      encoding: 'utf8', timeout: 10000
    });
    assert.equal(child.status, 23, child.stderr);
    assert.equal(await store.read(), before);
    assert.ok((await readdir(dir)).some(name => name.endsWith('.tmp')));
    await assert.rejects(store.initialized(), /interrupted encrypted write/);
  } finally { key.fill(0); await rm(dir, { recursive: true }); }
});
