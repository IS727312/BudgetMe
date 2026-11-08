import { randomBytes, scrypt, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { open, readFile, rename, unlink, mkdir, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateState } from './finance.mjs';

const derive = promisify(scrypt);
const KDF = { name: 'scrypt', N: 131072, r: 8, p: 1 };
export const MAX_VAULT = 12_000_000;
export class VaultError extends Error {}

export function passwordCheck(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128 || password.trim().length < 12) {
    throw new VaultError('Use a passphrase of 12 to 128 characters. Four or more unrelated words are recommended.');
  }
}
export async function newKey(password) {
  passwordCheck(password);
  const salt = randomBytes(32).toString('base64');
  const key = await derive(password, Buffer.from(salt, 'base64'), 32, { ...KDF, maxmem: 268435456 });
  return { key, salt };
}
function header(salt) { return { format: 'BudgetMe', version: 1, kdf: KDF, salt }; }
function aad(h) { return Buffer.from(JSON.stringify(h)); }
function b64(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new VaultError('Invalid encrypted vault.');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length && bytes.length !== length)) throw new VaultError('Invalid encrypted vault.');
  return bytes;
}
export function seal(state, key, salt) {
  const h = header(salt);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(h));
  const plaintext = Buffer.from(JSON.stringify(state));
  let ciphertext;
  try { ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]); } finally { plaintext.fill(0); }
  const data = JSON.stringify({ header: h, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
  if (Buffer.byteLength(data) > MAX_VAULT) throw new VaultError('Vault size limit reached. Remove old transactions or keep an encrypted archive.');
  return data;
}
function parse(data) {
  if (Buffer.byteLength(data) > MAX_VAULT) throw new VaultError('Encrypted vault exceeds the size limit.');
  let envelope;
  try { envelope = JSON.parse(data); } catch { throw new VaultError('Invalid encrypted vault.'); }
  const h = envelope?.header;
  if (!h || h.format !== 'BudgetMe' || h.version !== 1 || JSON.stringify(h.kdf) !== JSON.stringify(KDF) ||
      JSON.stringify(h) !== JSON.stringify(header(h.salt))) throw new VaultError('Unsupported or modified vault header.');
  b64(h.salt, 32); b64(envelope.iv, 12); b64(envelope.tag, 16); b64(envelope.ciphertext);
  return envelope;
}
export function unseal(data, key) {
  const e = parse(data);
  const decipher = createDecipheriv('aes-256-gcm', key, b64(e.iv, 12));
  decipher.setAAD(aad(e.header));
  decipher.setAuthTag(b64(e.tag, 16));
  let clear;
  try {
    clear = Buffer.concat([decipher.update(b64(e.ciphertext)), decipher.final()]);
    return validateState(JSON.parse(clear.toString('utf8')));
  } catch {
    throw new VaultError('Unable to unlock: wrong passphrase or damaged vault. No data was changed.');
  } finally { clear?.fill(0); }
}
export async function unlock(data, password) {
  passwordCheck(password);
  const e = parse(data);
  const key = await derive(password, b64(e.header.salt, 32), 32, { ...KDF, maxmem: 268435456 });
  try { return { state: unseal(data, key), key, salt: e.header.salt }; }
  catch (error) { key.fill(0); throw error; }
}
export async function exists(path) {
  try { await access(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
async function replace(from, to) {
  for (let attempt = 0; ; attempt++) {
    try { await rename(from, to); return; }
    catch (e) {
      if (!['EPERM', 'EBUSY'].includes(e.code) || attempt >= 4) throw e;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}
export async function atomicFile(path, data, beforeReplace) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(data);
    await handle.sync();
    await handle.close(); handle = undefined;
    if (beforeReplace) await beforeReplace(temp);
    await replace(temp, path);
  } finally {
    if (handle) await handle.close();
    try { await unlink(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
}
export class VaultStore {
  constructor(directory, fault = () => {}) {
    this.directory = directory; this.path = join(directory, 'vault.json'); this.previous = join(directory, 'vault.previous.json'); this.fault = fault;
  }
  async initialized() {
    await mkdir(this.directory, { recursive: true });
    const names = await readdir(this.directory);
    if (names.some(name => /^vault\..+\.tmp$/.test(name))) throw new VaultError('An interrupted encrypted write left a temporary file in data. Stop BudgetMe, preserve the file, and inspect the documented recovery steps before removing that specific temp file.');
    const current = await exists(this.path);
    if (!current && (await exists(this.previous) || await exists(join(this.directory, 'vault.pre-restore.json')))) throw new VaultError('Current vault is missing but a previous encrypted snapshot exists. Use the offline restore command; setup is disabled.');
    return current;
  }
  async read() { return readFile(this.path, 'utf8'); }
  async write(state, key, salt) {
    const encrypted = seal(state, key, salt);
    unseal(encrypted, key);
    this.fault('before-backup');
    if (await exists(this.path)) await atomicFile(this.previous, await this.read());
    this.fault('after-backup');
    await atomicFile(this.path, encrypted, async temp => {
      unseal(await readFile(temp, 'utf8'), key);
      this.fault('before-replace');
    });
  }
}

export async function acquireLock(directory) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'process.lock');
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (e) {
    if (e.code === 'EEXIST') throw new VaultError('Data is locked by another instance or an interrupted run. Close the running instance. If no BudgetMe process remains, inspect and remove data\\process.lock manually. Locks are never automatically stolen.');
    throw e;
  }
  const owner = { pid: process.pid, started: new Date().toISOString(), nonce: randomBytes(16).toString('hex') };
  await handle.writeFile(JSON.stringify(owner));
  await handle.sync();
  return Object.assign(async () => { await handle.close(); await unlink(path); }, { owner });
}
