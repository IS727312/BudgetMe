import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join, relative, isAbsolute } from 'node:path';
import { readFile, mkdir, readdir, unlink, stat } from 'node:fs/promises';
import { initialState, mutate, summarize, importCSV, excelXML, ValidationError, date } from './lib/finance.mjs';
import { VaultStore, VaultError, newKey, unlock, atomicFile, acquireLock } from './lib/vault.mjs';
import { AccessError, createAccess, openWindowsBrowser, serveReopen } from './lib/access.mjs';
import { runLauncher } from './lib/startup.mjs';

export const ROOT = dirname(fileURLToPath(import.meta.url));
const IDLE_MS = 15 * 60 * 1000;
const MAX_BODY = 1_500_000;
const assetMap = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml']
};
const exportName = /^budgetme-\d{13}-[a-f0-9]{12}\.(xml|encrypted\.json)$/;
function withinRoot(path) {
  const absolute = resolve(path), rel = relative(ROOT, absolute);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Writable path must be within the application folder.');
  return absolute;
}
function equal(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function secureHeaders(res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
}
function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
async function readJSON(req, limit = MAX_BODY) {
  if (req.headers['content-type'] !== 'application/json') throw new ValidationError('Only application/json requests are accepted.');
  if (Number(req.headers['content-length'] || 0) > limit) throw new ValidationError('Request is too large.');
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new ValidationError('Request is too large.');
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ValidationError('Invalid JSON request.'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ValidationError('Expected an input object.');
  return body;
}

export async function createBudgetServer(options = {}) {
  const dataDirectory = withinRoot(options.dataDirectory || join(ROOT, 'data'));
  const exportsDirectory = withinRoot(options.exportsDirectory || join(ROOT, 'exports'));
  const store = new VaultStore(dataDirectory);
  const releaseLock = await acquireLock(dataDirectory);
  let hasVault;
  try { hasVault = await store.initialized(); }
  catch (e) { await releaseLock(); throw e; }
  const launchToken = randomBytes(32).toString('hex');
  let current = null, sessionToken = null, lastActive = 0, failures = 0, nextAttempt = 0, busy = false;
  let origin, closed = false, access, closeBroker;
  const now = options.clock || Date.now;
  function lock() { current?.key.fill(0); current = null; sessionToken = null; lastActive = 0; }
  function authenticated(req) {
    if (current && now() - lastActive >= IDLE_MS) lock();
    if (!current || !equal(req.headers['x-budgetme-session'], sessionToken)) return false;
    lastActive = now();
    return true;
  }
  async function listExports() {
    await mkdir(exportsDirectory, { recursive: true });
    const names = (await readdir(exportsDirectory)).filter(name => exportName.test(name)).sort().reverse();
    return Promise.all(names.map(async name => ({ name, bytes: (await stat(join(exportsDirectory, name))).size, encrypted: name.endsWith('.json') })));
  }
  async function operate(req, res, path, body) {
    if (path === '/api/status') return send(res, 200, { initialized: hasVault, idleMinutes: 15 });
    if (path === '/api/setup' || path === '/api/unlock') {
      if (now() < nextAttempt) {
        res.setHeader('Retry-After', String(Math.ceil((nextAttempt - now()) / 1000)));
        return send(res, 429, { error: 'Unlock is temporarily paused. Wait before trying again.' });
      }
      if ((path === '/api/setup') === hasVault) return send(res, 409, { error: hasVault ? 'A vault already exists. Unlock it instead.' : 'Set up your vault first.' });
      try {
        if (path === '/api/setup') {
          const state = initialState(body.name);
          const derived = await newKey(body.password);
          try { await store.write(state, derived.key, derived.salt); }
          catch (e) { derived.key.fill(0); throw e; }
          current = { ...derived, state }; hasVault = true;
        } else {
          const candidate = await unlock(await store.read(), body.password);
          lock();
          current = candidate;
        }
      } catch (error) {
        failures++;
        nextAttempt = now() + Math.min(60000, 1000 * 2 ** Math.min(failures - 1, 6));
        if (error instanceof VaultError) return send(res, 401, { error: error.message });
        throw error;
      }
      failures = 0; nextAttempt = 0; lastActive = now();
      sessionToken = randomBytes(32).toString('hex');
      return send(res, 200, { session: sessionToken, profile: current.state.profile });
    }
    if (!authenticated(req)) return send(res, 401, { error: 'Vault is locked or this session has expired. Unlock again.' });
    if (path === '/api/lock') { lock(); return send(res, 200, { locked: true }); }
    if (path === '/api/state') {
      const day = date(body.day);
      return send(res, 200, { state: current.state, summary: summarize(current.state, day) });
    }
    if (path === '/api/change') {
      const next = mutate(structuredClone(current.state), body.action, body.input);
      await store.write(next, current.key, current.salt);
      current.state = next;
      return send(res, 200, { saved: true });
    }
    if (path === '/api/import') {
      const result = importCSV(current.state, body.csv);
      if (body.preview === true) return send(res, 200, { added: result.added, skipped: result.skipped, preview: true });
      if (body.confirm !== 'IMPORT') throw new ValidationError('Preview your CSV, then confirm IMPORT.');
      await store.write(result.state, current.key, current.salt); current.state = result.state;
      return send(res, 200, { added: result.added, skipped: result.skipped });
    }
    if (path === '/api/exports') return send(res, 200, { files: await listExports() });
    if (path === '/api/export') {
      const files = await listExports();
      if (files.length >= 50) throw new ValidationError('Export limit reached (50). Remove an old export first.');
      if (!['excel', 'backup'].includes(body.kind)) throw new ValidationError('Choose an Excel export or encrypted backup.');
      if (body.kind === 'excel' && body.confirm !== 'EXPORT') throw new ValidationError('Type EXPORT to acknowledge that Excel files are unencrypted.');
      const name = `budgetme-${Date.now()}-${randomBytes(6).toString('hex')}.${body.kind === 'excel' ? 'xml' : 'encrypted.json'}`;
      const data = body.kind === 'excel' ? excelXML(current.state) : await store.read();
      await atomicFile(join(exportsDirectory, name), data);
      return send(res, 200, { name, directory: 'app\\exports', encrypted: body.kind !== 'excel' });
    }
    if (path === '/api/export-delete') {
      if (!exportName.test(body.name)) throw new ValidationError('Invalid export name.');
      try { await unlink(join(exportsDirectory, body.name)); }
      catch (e) { if (e.code === 'ENOENT') throw new ValidationError('Export no longer exists.'); throw e; }
      return send(res, 200, { removed: true });
    }
    return send(res, 404, { error: 'Unknown API endpoint.' });
  }
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    secureHeaders(res);
    if (req.headers.host !== origin?.slice(7)) return send(res, 403, { error: 'Invalid local Host.' });
    if (req.headers.origin && req.headers.origin !== origin) return send(res, 403, { error: 'Cross-origin requests are blocked.' });
    if (!req.url || req.url.includes('?') || req.url.includes('#')) return send(res, 400, { error: 'Query strings are not supported.' });
    const path = req.url;
    if (assetMap[path] && req.method === 'GET') {
      try {
        const [name, type] = assetMap[path];
        const bytes = await readFile(join(ROOT, 'public', name));
        res.writeHead(200, { 'Content-Type': type }); return res.end(bytes);
      } catch { return send(res, 500, { error: 'Local application assets are unavailable.' }); }
    }
    if (path === '/access/claim' || path === '/access/reopen') {
      if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for local access requests.' });
      if (req.headers.origin !== origin || req.headers['sec-fetch-site'] !== 'same-origin' ||
          req.headers['x-budgetme-open'] !== '1') return send(res, 403, { error: 'Exact same-origin access requests are required.' });
      try {
        const body = await readJSON(req, 256);
        if (path === '/access/claim') return send(res, 200, { launch: access.claim(body.code) });
        return send(res, 200, await access.open('http'));
      } catch (error) {
        if (error instanceof AccessError) {
          if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
          return send(res, error.status, { error: error.message });
        }
        if (error instanceof ValidationError) return send(res, 400, { error: error.message });
        console.error('BudgetMe access request failed (INTERNAL). No request data logged.');
        return send(res, 500, { error: 'The opening request failed. Double-click Launch BudgetMe.cmd to try again.' });
      }
    }
    if (!path.startsWith('/api/')) return send(res, 404, { error: 'Not found.' });
    if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: 'Cross-site requests are blocked.' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST for local APIs.' });
    if (req.headers.origin !== origin) return send(res, 403, { error: 'Exact local Origin is required.' });
    if (!equal(req.headers['x-budgetme-launch'], launchToken)) return send(res, 403, {
      gate: 'launch_invalid', error: 'Click Open BudgetMe or double-click Launch BudgetMe.cmd, then unlock your vault.'
    });
    if (busy) return send(res, 409, { error: 'Another operation is in progress. Try again shortly.' });
    busy = true;
    try { await operate(req, res, path, await readJSON(req)); }
    catch (error) {
      if (error instanceof ValidationError || error instanceof VaultError) send(res, 400, { error: error.message });
      else {
        console.error(`BudgetMe operation failed (${typeof error.code === 'string' ? error.code : 'INTERNAL'}). No request data logged.`);
        send(res, 500, { error: 'Operation failed. Your last saved vault is unchanged. Check local disk access and available space.' });
      }
    } finally { busy = false; }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 32;
  const expiry = setInterval(() => { if (current && now() - lastActive >= IDLE_MS) lock(); }, 1000);
  expiry.unref();
  try {
    await new Promise((resolveReady, reject) => {
      server.once('error', reject);
      server.listen({ host: '127.0.0.1', port: options.port ?? 47821, exclusive: true }, () => {
        server.removeListener('error', reject); resolveReady();
      });
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    access = createAccess({
      origin, launchToken, clock: now,
      opener: options.openBrowser || (address => openWindowsBrowser(address, dirname(ROOT)))
    });
    closeBroker = await serveReopen(dataDirectory, releaseLock.owner, access);
  } catch (e) {
    clearInterval(expiry); access?.close();
    if (server.listening) await new Promise(done => server.close(done));
    lock(); await releaseLock(); throw e;
  }
  return {
    server, origin, launchToken, launchURL: `${origin}/#${launchToken}`,
    requestOpen: source => access.open(source),
    async close() {
      if (closed) return; closed = true;
      clearInterval(expiry);
      access.close(); await closeBroker();
      await new Promise(resolveClosed => { server.close(resolveClosed); server.closeIdleConnections(); });
      lock(); await releaseLock();
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await runLauncher({ directory: join(ROOT, 'data'), factory: () => createBudgetServer() });
  } catch (error) {
    console.error(error instanceof VaultError || error instanceof AccessError ? error.message : `BudgetMe could not start (${error.code || 'INTERNAL'}). No alternate public address will be used.`);
    process.exitCode = 1;
  }
}
