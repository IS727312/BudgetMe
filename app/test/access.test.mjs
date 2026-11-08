import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { ROOT, createBudgetServer } from '../server.mjs';
import { AccessError, browserArguments, createAccess, brokerAddress, requestReopen } from '../lib/access.mjs';
import { startOrReopen } from '../lib/startup.mjs';

const password = 'synthetic-only access regression passphrase';
async function context() {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.runtime', 'access-test-'));
  const opened = [];
  const options = {
    port: 0, dataDirectory: join(directory, 'data'), exportsDirectory: join(directory, 'exports'),
    openBrowser: async address => { opened.push(address); }
  };
  const app = await createBudgetServer(options);
  return {
    app, directory, options, opened,
    async post(path, body = {}, extra = {}) {
      const response = await fetch(app.origin + path, {
        method: 'POST', headers: {
          Origin: app.origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin',
          'X-BudgetMe-Open': '1', ...extra
        }, body: JSON.stringify(body), credentials: 'omit'
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    },
    async close() { await app.close(); await rm(directory, { recursive: true }); }
  };
}
const codeFrom = address => new URL(address).hash.slice(6);

test('native opener arguments contain only a fixed loopback destination and a short-lived fragment, without a shell', () => {
  const url = `http://127.0.0.1:47821/#open=${'a'.repeat(64)}`;
  assert.deepEqual(browserArguments(url), ['url.dll,FileProtocolHandler', url]);
  for (const address of [
    'https://evil.example/', 'http://localhost:47821/', 'http://127.0.0.1:47821/?token=secret',
    `http://user@127.0.0.1:47821/#open=${'a'.repeat(64)}`,
    `http://127.0.0.1:47821/elsewhere#open=${'a'.repeat(64)}`,
    'http://127.0.0.1:47821/#open=anything&calc.exe'
  ]) assert.throws(() => browserArguments(address));
});

test('one-use grants expire at exactly 60 seconds, never revoke capabilities, and separate HTTP from launcher cooldowns', async () => {
  let time = 100000;
  const opened = [], capability = randomBytes(32).toString('hex');
  const access = createAccess({ origin: 'http://127.0.0.1:55555', launchToken: capability, clock: () => time, opener: async address => { opened.push(address); } });
  await access.open('http');
  const httpCode = codeFrom(opened[0]);
  await assert.rejects(access.open('http'), error => error.status === 429);
  await access.open('ipc');
  const ipcCode = codeFrom(opened[1]);
  assert.notEqual(httpCode, ipcCode);
  assert.throws(() => access.claim('f'.repeat(64)), /expired or was already used/);
  time += 10001;
  await access.open('http');
  assert.equal(codeFrom(opened[2]), httpCode, 'An in-flight browser grant was revoked by another trigger.');
  assert.equal(access.claim(httpCode), capability);
  assert.throws(() => access.claim(httpCode), /expired or was already used/);
  time = 159999;
  assert.equal(access.claim(ipcCode), capability);
  await access.open('ipc');
  const expiredCode = codeFrom(opened.at(-1));
  time += 60000;
  assert.throws(() => access.claim(expiredCode), /expired or was already used/);
  await access.open('ipc');
  const freshCode = codeFrom(opened.at(-1));
  assert.notEqual(freshCode, expiredCode);
  access.close();
  assert.throws(() => access.claim(freshCode), /expired or was already used/);
  await assert.rejects(access.open('ipc'), /stopping/);
});

test('opening failures are explicit, bounded, and do not disclose their URL or arbitrary opener errors', async () => {
  const access = createAccess({
    origin: 'http://127.0.0.1:55555', launchToken: randomBytes(32).toString('hex'),
    opener: async address => { throw new Error(address); }
  });
  await assert.rejects(access.open('ipc'), error => error instanceof AccessError &&
    error.message.includes('default browser') && !error.message.includes('#open='));
  await assert.rejects(access.open('ipc'), error => error.status === 429);
});

test('public reopen and one-use claim enforce exact Host/Origin, same-origin metadata, JSON and custom headers', async () => {
  const c = await context();
  try {
    assert.equal(c.app.server.address().address, '127.0.0.1');
    for (const path of ['/access/reopen', '/access/claim']) {
      assert.equal((await fetch(c.app.origin + path)).status, 405);
      assert.equal((await fetch(c.app.origin + path, { method: 'OPTIONS' })).status, 405);
      for (const extra of [
        { Origin: '' }, { Origin: 'https://evil.example' },
        { 'Sec-Fetch-Site': '' }, { 'Sec-Fetch-Site': 'none' }, { 'Sec-Fetch-Site': 'same-site' },
        { 'Sec-Fetch-Site': 'cross-site' }, { 'X-BudgetMe-Open': '' }
      ]) assert.equal((await c.post(path, {}, extra)).status, 403, JSON.stringify(extra));
      const badHost = await new Promise((done, reject) => {
        const req = http.request(c.app.origin + path, { method: 'POST', headers: {
          Host: 'evil.example', Origin: c.app.origin, 'Content-Type': 'application/json',
          'Sec-Fetch-Site': 'same-origin', 'X-BudgetMe-Open': '1'
        } }, res => { res.resume(); res.once('end', () => done(res.statusCode)); });
        req.once('error', reject); req.end('{}');
      });
      assert.equal(badHost, 403);
      assert.equal((await c.post(path, {}, { 'Content-Type': 'text/plain' })).status, 400);
      assert.equal((await c.post(path, { input: 'x'.repeat(257) })).status, 400);
      assert.equal((await c.post(path + '?code=secret')).status, 400);
    }
    assert.equal(c.opened.length, 0);
    const reopened = await c.post('/access/reopen');
    assert.deepEqual(reopened.body, { requested: true });
    assert.equal(reopened.headers.get('set-cookie'), null);
    assert.equal(reopened.headers.get('access-control-allow-origin'), null);
    assert.equal(reopened.headers.get('cache-control'), 'no-store');
    assert.ok(!JSON.stringify(reopened.body).includes(c.app.launchToken));
    assert.ok(!JSON.stringify(reopened.body).includes(codeFrom(c.opened[0])));
    assert.equal((await c.post('/access/reopen')).status, 429);
    const code = codeFrom(c.opened[0]);
    assert.equal((await c.post('/access/claim', { code }, { Origin: 'https://evil.example' })).status, 403);
    const claimed = await c.post('/access/claim', { code });
    assert.equal(claimed.status, 200);
    assert.deepEqual(Object.keys(claimed.body), ['launch']);
    assert.equal(claimed.body.launch, c.app.launchToken);
    assert.equal((await c.post('/access/claim', { code })).status, 403);
    assert.equal((await c.post('/api/state', { day: '2026-11-07' }, { 'X-BudgetMe-Launch': claimed.body.launch })).status, 401);
    const invalidGate = await c.post('/api/status');
    assert.equal(invalidGate.status, 403);
    assert.equal(invalidGate.body.gate, 'launch_invalid');
    assert.equal((await c.post('/api/status', {}, { Origin: 'https://evil.example' })).body.gate, undefined);
  } finally { await c.close(); }
});

test('reopen and refresh never inherit or revoke an unlocked session; a fresh passphrase still rotates the sole session', async () => {
  const c = await context();
  try {
    const headers = { 'X-BudgetMe-Launch': c.app.launchToken };
    const setup = await c.post('/api/setup', { name: 'Synthetic access user', password }, headers);
    assert.equal(setup.status, 200);
    const existing = { ...headers, 'X-BudgetMe-Session': setup.body.session };
    assert.equal((await c.post('/api/state', { day: '2026-11-07' }, existing)).status, 200);
    await c.post('/access/reopen');
    const claim = await c.post('/access/claim', { code: codeFrom(c.opened[0]) });
    assert.equal((await c.post('/api/state', { day: '2026-11-07' }, { 'X-BudgetMe-Launch': claim.body.launch })).status, 401);
    assert.equal((await c.post('/api/state', { day: '2026-11-07' }, existing)).status, 200);
    const unlocked = await c.post('/api/unlock', { password }, { 'X-BudgetMe-Launch': claim.body.launch });
    assert.equal(unlocked.status, 200);
    assert.notEqual(unlocked.body.session, setup.body.session);
    assert.equal((await c.post('/api/state', { day: '2026-11-07' }, existing)).status, 401);
    const fresh = { ...headers, 'X-BudgetMe-Session': unlocked.body.session };
    assert.equal((await c.post('/api/lock', {}, fresh)).status, 200);
    assert.equal((await c.post('/api/state', { day: '2026-11-07' }, fresh)).status, 401);
  } finally { await c.close(); }
});

test('trigger-only real IPC returns no capability or browser URL and releases normally with its owner lock', async () => {
  const c = await context();
  try {
    const owner = JSON.parse(await readFile(join(c.directory, 'data', 'process.lock'), 'utf8'));
    assert.deepEqual(await requestReopen(join(c.directory, 'data'), owner), { requested: true });
    assert.equal(c.opened.length, 1);
    assert.equal((await c.post('/api/status')).status, 403);
    const response = await new Promise((done, reject) => {
      const socket = net.connect(brokerAddress(join(c.directory, 'data'), owner));
      let output = '';
      socket.once('error', reject);
      socket.once('connect', () => socket.write('{"action":"open","url":"https://evil.example"}\n'));
      socket.on('data', bytes => { output += bytes; });
      socket.once('end', () => done(JSON.parse(output)));
    });
    assert.equal(response.ok, false);
    assert.ok(!JSON.stringify(response).includes(c.app.launchToken));
    assert.ok(!JSON.stringify(response).includes('#open='));
    assert.equal(c.opened.length, 1);
    await c.app.close();
    await assert.rejects(readFile(join(c.directory, 'data', 'process.lock')), error => error.code === 'ENOENT');
    await assert.rejects(requestReopen(join(c.directory, 'data'), owner));
  } finally { await c.close(); }
});

test('start-or-reopen handles simultaneous startup without duplicate servers or lock stealing', async () => {
  const c = await context();
  let app;
  try {
    await c.app.close();
    let created = 0;
    const settings = {
      directory: join(c.directory, 'data'),
      factory: async () => { created++; app = await createBudgetServer(c.options); return app; }
    };
    const results = await Promise.all([startOrReopen(settings), startOrReopen(settings)]);
    assert.equal(results.filter(result => result.created).length, 1);
    assert.equal(results.filter(result => !result.created).length, 1);
    assert.equal((await fetch(app.origin)).status, 200);
    assert.ok(created <= 2, 'Unexpected retry loop.');
    assert.equal(c.opened.length, 1);
  } finally { if (app) await app.close(); await c.close(); }
});

test('stale locks and live owners without a broker fail explicitly without invoking a second server', async () => {
  const c = await context();
  try {
    await c.app.close();
    const path = join(c.directory, 'data', 'process.lock');
    const stale = { pid: 2147483647, nonce: randomBytes(16).toString('hex'), started: new Date().toISOString() };
    let invoked = false;
    await writeFile(path, JSON.stringify(stale));
    await assert.rejects(startOrReopen({ directory: join(c.directory, 'data'), factory: () => { invoked = true; } }), /interrupted run/);
    assert.equal(invoked, false);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), stale);
    const legacy = { ...stale, pid: process.pid };
    await writeFile(path, JSON.stringify(legacy));
    await assert.rejects(startOrReopen({ directory: join(c.directory, 'data'), factory: () => { invoked = true; } }), /existing server cannot reopen/);
    assert.equal(invoked, false);
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), legacy);
  } finally { await c.close(); }
});
