import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, access, stat } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ROOT, createBudgetServer } from '../server.mjs';
import { fingerprint } from './fingerprint.mjs';
import { atomicFile } from '../lib/vault.mjs';

let executable;
for (const path of ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe']) {
  try { await access(path); executable = path; break; } catch (e) { if (e.code !== 'ENOENT') throw e; }
}
if (!executable) throw new Error('Preinstalled Edge is unavailable. No browser download is authorized.');
const output = join(ROOT, '.runtime', 'ui');
await mkdir(output, { recursive: true });
const startFingerprint = await fingerprint();
const work = await mkdtemp(join(output, 'browser-test-'));
const driver = await readFile(join(ROOT, 'tools', 'browser-driver.js'));
const requests = new Set();
const viewports = [];
let app, proxy;
async function run(width, height, screenshot, index) {
  const base = join(work, `run-${index}`), env = { ...process.env };
  for (const [variable, folder] of Object.entries({ TEMP: 'temp', TMP: 'temp', HOME: 'home', USERPROFILE: 'home', APPDATA: 'appdata', LOCALAPPDATA: 'localappdata', XDG_CACHE_HOME: 'cache' })) {
    env[variable] = join(base, folder); await mkdir(env[variable], { recursive: true });
  }
  let phase = 'initial', openedAddress, hideCleared = false, probeMode = null, claims = 0, probes = 0;
  const probeCases = [];
  app = await createBudgetServer({
    port: 0, dataDirectory: join(base, 'data'), exportsDirectory: join(base, 'exports'),
    openBrowser: async address => { openedAddress = address; }
  });
  // The synthetic-only adapter injects the driver without adding test routes to the real app.
  proxy = http.createServer((req, res) => {
    if (['/synthetic-phase', '/synthetic-open-request', '/synthetic-observe-hide', '/synthetic-probe', '/synthetic-issue'].includes(req.url)) {
      let input = '';
      req.on('data', chunk => { input += chunk; });
      req.on('end', async () => {
        if (req.method === 'POST') {
          const value = JSON.parse(input);
          if (req.url === '/synthetic-phase') phase = value.phase;
          if (req.url === '/synthetic-observe-hide') hideCleared = value.cleared;
          if (req.url === '/synthetic-probe') probeMode = value.mode;
        }
        if (req.url === '/synthetic-issue') {
          try { await app.requestOpen('ipc'); }
          catch (error) {
            if (error.status !== 429) { res.writeHead(500); res.end('Synthetic opening failed.'); return; }
            await new Promise(done => setTimeout(done, 1100));
            await app.requestOpen('ipc');
          }
        }
        const value = ['/synthetic-open-request', '/synthetic-issue'].includes(req.url)
          ? { url: `http://127.0.0.1:${proxy.address().port}/${new URL(openedAddress).hash}` }
          : { phase, claims, probes };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(value));
      });
      return;
    }
    if (req.url === '/access/claim') claims++;
    if (req.url === '/api/status') {
      probes++;
      if (probeMode) {
        const mode = probeMode; probeMode = mode === 'network' ? 'network' : null;
        probeCases.push(mode);
        req.resume();
        if (mode === 'network') { req.socket.destroy(); return; }
        res.writeHead(mode === 'busy' ? 409 : 403, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(mode === 'invalid' ? { gate: 'launch_invalid', error: 'Synthetic stale gate.' } : { error: 'Synthetic guarded request.' }));
        return;
      }
    }
    if (req.url === '/synthetic-driver.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' }); res.end(driver); return;
    }
    requests.add(req.url);
    const forwarded = http.request(app.origin + req.url, { method: req.method, headers: {
      ...req.headers, host: app.origin.slice(7), ...(req.headers.origin ? { origin: app.origin } : {})
    } }, backend => {
      const chunks = [];
      backend.on('data', chunk => chunks.push(chunk));
      backend.on('end', () => {
        let body = Buffer.concat(chunks);
        const headers = { ...backend.headers };
        if (req.url === '/') body = Buffer.from(body.toString('utf8').replace('<script src="/app.js"', '<script src="/synthetic-driver.js" defer></script><script src="/app.js"'));
        delete headers['content-length']; delete headers['transfer-encoding'];
        res.writeHead(backend.statusCode, headers); res.end(body);
      });
    });
    forwarded.on('error', () => { res.writeHead(502); res.end('Synthetic test adapter failed.'); });
    req.pipe(forwarded);
  });
  await new Promise(resolveReady => proxy.listen({ host: '127.0.0.1', port: 0, exclusive: true }, resolveReady));
  await app.requestOpen('ipc');
  const url = `http://127.0.0.1:${proxy.address().port}/${new URL(openedAddress).hash}`;
  const args = [
    '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-extensions', '--disable-default-apps',
    '--disable-domain-reliability', '--disable-breakpad', '--disable-crash-reporter', '--metrics-recording-only',
    '--disable-client-side-phishing-detection', '--disable-features=msEdgeSidebarV2,msEdgeShoppingAssistant,OptimizationHints,MediaRouter,Translate',
    '--password-store=basic', `--user-data-dir=${join(base, 'profile')}`, `--disk-cache-dir=${join(base, 'cache')}`,
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1', `--window-size=${width},${height}`,
    '--virtual-time-budget=120000', '--timeout=120000', '--dump-dom', `--screenshot=${join(output, screenshot)}`, url
  ];
  const child = spawn(executable, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { if (stderr.length < 5000) stderr += chunk; });
  const status = await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      const stop = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { cwd: ROOT, env, stdio: 'ignore' });
      stop.once('error', error => reject(new Error(`Could not stop owned browser PID ${child.pid}: ${error.code}`)));
      stop.once('exit', () => reject(new Error('Owned browser exceeded its 150-second bounded check and its specific process tree was stopped.')));
    }, 150000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolveExit({ code, signal }); });
  });
  if (status.code !== 0) throw new Error(`Preinstalled browser failed (${status.code ?? status.signal}): ${stderr}`);
  const result = stdout.match(/data-budgetme-result="([^"]+)"/)?.[1];
  if (result !== 'passed') {
    await atomicFile(join(output, 'synthetic-browser-failure.html'), stdout.replaceAll(/[a-f0-9]{64}/g, '[redacted]'));
    await atomicFile(join(output, 'synthetic-browser-failure.json'), JSON.stringify({ phase, hideCleared, probeMode, probeCases, claims, probes, requests: [...requests] }, null, 2));
    const reason = stdout.match(/<pre id="synthetic-result"[^>]*>([\s\S]*?)<\/pre>/)?.[1] || 'Driver did not finish.';
    throw new Error(`Real ${width}px browser check failed: ${reason}`);
  }
  const actualViewport = stdout.match(/data-budgetme-viewport="(\d+)x(\d+)"/);
  assert.ok(actualViewport, 'Actual browser viewport was not reported.');
  assert.ok(index === 1 ? Number(actualViewport[1]) >= 1000 : Number(actualViewport[1]) >= 320 && Number(actualViewport[1]) <= 600,
    'Installed browser did not produce the required desktop or narrow viewport.');
  viewports.push({ width: Number(actualViewport[1]), height: Number(actualViewport[2]) });
  assert.ok((await stat(join(output, screenshot))).size > 10000, 'Browser screenshot is empty or unexpectedly small.');
  assert.equal(phase, 'reopen', 'Real refresh and fresh-ticket re-entry were not exercised.');
  assert.equal(hideCleared, true, 'The real pagehide transition retained private state or DOM.');
  await new Promise(resolveClosed => { proxy.close(resolveClosed); proxy.closeIdleConnections(); }); proxy = null;
  await app.close(); app = null;
}
try {
  await run(1440, 1100, 'overview.png', 1);
  await run(500, 844, 'narrow.png', 2);
  assert.ok(requests.has('/api/import') && requests.has('/api/lock') && requests.has('/app.js') &&
    requests.has('/access/claim') && requests.has('/access/reopen'));
  await mkdir(join(ROOT, '.runtime', 'release'), { recursive: true });
  assert.equal(await fingerprint(), startFingerprint, 'Source changed during browser verification.');
  await atomicFile(join(ROOT, '.runtime', 'release', 'browser.json'), JSON.stringify({
    fingerprint: startFingerprint, passed: true, at: new Date().toISOString(), browser: 'Preinstalled Edge headless',
    syntheticOnly: true, viewports, requests: [...requests], screenshots: ['.runtime\\ui\\overview.png', '.runtime\\ui\\narrow.png'],
    coverage: 'Real one-use bootstrap, DOM forms, onboarding, accounts, income/expenses/transfers, budgets, goals, CSV/rules, backup/Excel, history/search, lock/re-authentication, actual reload/pagehide clearing, token-free Open button, fresh-fragment re-entry requiring passphrase, authorized-tab/form preservation, 200/409/other-403/network/machine-coded invalid-gate branches, hostile fragments and queued tickets, wipe only after replacement claim succeeds, late response blocking, empty auth storage, measured desktop/narrow viewports, early window errors/unhandled rejection/CSP and same-origin application resources.',
    limitation: 'Synthetic adapter rewrites Host/Origin; direct adversarial HTTP tests separately verify those guards. Its in-memory test-only opener navigates the isolated renderer rather than invoking the OS default browser or opening a second native window. Actual Windows default-browser association is untested to avoid outside-folder profile writes. Edge clamps minimum window sizes and deducts native borders; actual measured viewports are recorded. Smaller mobile layouts are unverified. Driver intentionally couples to app globals. Windows/browser background networking is outside application guarantees.'
  }, null, 2));
  console.log(`Real browser checks passed at measured ${viewports.map(v => `${v.width}x${v.height}`).join(' / ')} viewports, using only synthetic workspace data.`);
} finally {
  if (proxy) await new Promise(resolveClosed => { proxy.close(resolveClosed); proxy.closeAllConnections(); });
  if (app) await app.close();
  await rm(work, { recursive: true, maxRetries: 5, retryDelay: 200 });
}
