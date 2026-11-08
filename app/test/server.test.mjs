import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { ROOT, createBudgetServer } from '../server.mjs';

const password = 'synthetic-only long test passphrase';
async function context(options = {}) {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const dir = await mkdtemp(join(ROOT, '.runtime', 'http-test-'));
  const app = await createBudgetServer({ port: 0, dataDirectory: join(dir, 'data'), exportsDirectory: join(dir, 'exports'), ...options });
  let session;
  const request = async (path, body = {}, extra = {}) => {
    const res = await fetch(app.origin + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: app.origin,
        'X-BudgetMe-Launch': app.launchToken, ...(session ? { 'X-BudgetMe-Session': session } : {}), ...extra },
      body: JSON.stringify(body)
    });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  return {
    app, dir, request, setSession: value => { session = value; },
    async setup() { const response = await request('/api/setup', { name: 'Synthetic HTTP Tester', password }); assert.equal(response.status, 200); session = response.body.session; },
    async close() { await app.close(); await rm(dir, { recursive: true }); }
  };
}
test('loopback assets, strict headers, no CORS, and protection on every API route', async () => {
  const c = await context();
  try {
    assert.equal(c.app.server.address().address, '127.0.0.1');
    const shell = await fetch(c.app.origin);
    assert.equal(shell.status, 200); assert.equal(shell.headers.get('cache-control'), 'no-store');
    assert.ok(shell.headers.get('content-security-policy').includes("frame-ancestors 'none'"));
    assert.equal(shell.headers.get('access-control-allow-origin'), null);
    assert.equal(shell.headers.get('set-cookie'), null);
    const externalNavigation = await fetch(c.app.origin, { headers: { 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(externalNavigation.status, 200);
    assert.ok(!(await externalNavigation.text()).includes('Synthetic HTTP Tester'));
    assert.equal((await fetch(c.app.origin + '/api/status')).status, 405);
    const badHost = await new Promise((resolveResponse, reject) => {
      const req = http.request(c.app.origin + '/api/status', { method: 'POST', headers: {
        Host: 'evil.example', Origin: c.app.origin, 'Content-Type': 'application/json', 'X-BudgetMe-Launch': c.app.launchToken
      } }, res => { res.resume(); res.on('end', () => resolveResponse(res.statusCode)); });
      req.on('error', reject); req.end('{}');
    });
    assert.equal(badHost, 403);
    assert.equal((await c.request('/api/status', {}, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await c.request('/api/status', {}, { Origin: '' })).status, 403);
    assert.equal((await c.request('/api/status', {}, { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await c.request('/api/status', {}, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    for (const route of ['status', 'setup', 'unlock', 'state', 'change', 'lock', 'import', 'exports', 'export', 'export-delete']) {
      assert.equal((await c.request('/api/' + route, {}, { 'X-BudgetMe-Launch': '' })).status, 403, route);
    }
    assert.equal((await c.request('/api/status?token=abc')).status, 400);
    assert.equal((await fetch(c.app.origin + '/data/vault.json')).status, 404);
    assert.equal((await c.request('/api/status', {}, { 'Content-Type': 'text/plain' })).status, 400);
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).status, 401);
  } finally { await c.close(); }
});
test('setup, persisted encrypted writes, lock, reauthentication and exclusive ownership', async () => {
  const c = await context();
  try {
    await c.setup();
    assert.equal((await c.request('/api/setup', { name: 'x', password })).status, 409);
    await assert.rejects(createBudgetServer({ port: 0, dataDirectory: join(c.dir, 'data') }), /locked/);
    assert.equal((await c.request('/api/change', { action: 'account', input: { name: 'Synthetic Bank', institution: 'Fidelity', kind: 'investment', opening: '10' } })).status, 200);
    assert.ok(!(await readFile(join(c.dir, 'data', 'vault.json'), 'utf8')).includes('Synthetic Bank'));
    const oldSession = (await c.request('/api/unlock', { password })).body.session;
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).status, 401);
    c.setSession(oldSession);
    const result = await c.request('/api/state', { day: '2026-11-07' });
    assert.equal(result.body.state.accounts[0].name, 'Synthetic Bank');
    assert.equal((await c.request('/api/lock')).status, 200);
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).status, 401);
    const unlocked = await c.request('/api/unlock', { password }); c.setSession(unlocked.body.session);
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).body.state.accounts.length, 1);
  } finally { await c.close(); }
});
test('wrong password backoff and exact inactivity expiry', async () => {
  let now = 1000000;
  const c = await context({ clock: () => now });
  try {
    await c.setup(); await c.request('/api/lock');
    assert.equal((await c.request('/api/unlock', { password: 'incorrect synthetic password' })).status, 401);
    assert.equal((await c.request('/api/unlock', { password })).status, 429);
    now += 1001;
    const result = await c.request('/api/unlock', { password }); c.setSession(result.body.session);
    now += 15 * 60 * 1000 - 1;
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).status, 200);
    now += 15 * 60 * 1000;
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).status, 401);
  } finally { await c.close(); }
});
test('request limits, mutation rollback, CSV preview/import and plaintext export confirmation', async () => {
  const c = await context();
  try {
    await c.setup();
    assert.equal((await c.request('/api/change', { action: 'account', input: { name: 'Checking', institution: 'Chase', kind: 'checking', opening: '0' } })).status, 200);
    const before = (await c.request('/api/state', { day: '2026-11-07' })).body.state;
    assert.equal((await c.request('/api/change', { action: 'transaction', input: { type: 'expense', accountId: before.accounts[0].id, date: 'invalid', amount: '1' } })).status, 400);
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).body.state.transactions.length, 0);
    const csv = 'date,type,account,category,amount,description\n2026-11-07,income,Checking,,100,Synthetic income';
    assert.equal((await c.request('/api/import', { csv, preview: true })).body.added, 1);
    assert.equal((await c.request('/api/state', { day: '2026-11-07' })).body.state.transactions.length, 0);
    assert.equal((await c.request('/api/import', { csv })).status, 400);
    assert.equal((await c.request('/api/import', { csv, confirm: 'IMPORT' })).body.added, 1);
    assert.equal((await c.request('/api/export', { kind: 'excel' })).status, 400);
    const plain = await c.request('/api/export', { kind: 'excel', confirm: 'EXPORT' });
    assert.equal(plain.status, 200); assert.ok((await readFile(join(c.dir, 'exports', plain.body.name), 'utf8')).includes('Synthetic income'));
    const backup = await c.request('/api/export', { kind: 'backup' });
    assert.ok(!(await readFile(join(c.dir, 'exports', backup.body.name), 'utf8')).includes('Synthetic income'));
    assert.equal((await c.request('/api/export-delete', { name: '..\\data\\vault.json' })).status, 400);
    assert.equal((await c.request('/api/export-delete', { name: plain.body.name })).status, 200);
    assert.equal((await c.request('/api/status', { padding: 'x'.repeat(1_500_001) })).status, 400);
  } finally { await c.close(); }
});
test('restart forgets all tokens and unlocks durable data with correct passphrase', async () => {
  const c = await context();
  let restarted;
  try {
    await c.setup();
    await c.app.close();
    restarted = await createBudgetServer({ port: 0, dataDirectory: join(c.dir, 'data'), exportsDirectory: join(c.dir, 'exports') });
    const request = async (token, path, body) => fetch(restarted.origin + path, { method: 'POST', headers: {
      Origin: restarted.origin, 'Content-Type': 'application/json', 'X-BudgetMe-Launch': token
    }, body: JSON.stringify(body) });
    assert.equal((await request(c.app.launchToken, '/api/status', {})).status, 403);
    const unlocked = await request(restarted.launchToken, '/api/unlock', { password });
    assert.equal(unlocked.status, 200);
  } finally { if (restarted) await restarted.close(); await c.close(); }
});
test('port squatting fails loudly and releases only the failed instance data lock', async () => {
  const c = await context();
  try {
    const dir = join(c.dir, 'second-instance');
    await assert.rejects(createBudgetServer({ port: c.app.server.address().port, dataDirectory: dir }), error => error.code === 'EADDRINUSE');
    const retry = await createBudgetServer({ port: 0, dataDirectory: dir });
    await retry.close();
    assert.equal((await c.request('/api/status')).status, 200);
  } finally { await c.close(); }
});
