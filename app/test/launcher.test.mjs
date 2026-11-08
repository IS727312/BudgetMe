import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../server.mjs';

async function fixture(withServer = true, openerError = false) {
  await mkdir(join(ROOT, '.runtime'), { recursive: true });
  const directory = await mkdtemp(join(ROOT, '.runtime', 'cmd launcher space '));
  await copyFile(join(ROOT, '..', 'Launch BudgetMe.cmd'), join(directory, 'Launch BudgetMe.cmd'));
  if (withServer) {
    await mkdir(join(directory, 'app', 'tools'), { recursive: true });
    await writeFile(join(directory, 'app', 'server.mjs'), '// Synthetic fixture imports the real server from its startup helper.');
    await writeFile(join(directory, 'app', 'tools', 'launch.mjs'), `
      import assert from 'node:assert/strict';
      import { join } from 'node:path';
      import { createBudgetServer } from ${JSON.stringify(pathToFileURL(join(ROOT, 'server.mjs')).href)};
      import { runLauncher } from ${JSON.stringify(pathToFileURL(join(ROOT, 'lib', 'startup.mjs')).href)};
      const root = ${JSON.stringify(directory)};
      for (const [variable, part] of Object.entries({
        TEMP:'temp', TMP:'temp', HOME:'home', USERPROFILE:'home', APPDATA:'appdata',
        LOCALAPPDATA:'localappdata', XDG_CACHE_HOME:'cache'
      })) assert.equal(process.env[variable], join(root, '.runtime', part), variable);
      assert.equal(process.env.npm_config_cache, join(root, '.runtime', 'cache', 'npm'));
      assert.equal(process.env.npm_config_update_notifier, 'false');
      assert.equal(process.cwd(), join(root, 'app'));
      console.log('SYNTHETIC_ENVIRONMENT_OK');
      try {
        await runLauncher({
          directory: join(root, 'app', 'data'),
          factory: async () => {
            const app = await createBudgetServer({
              port: 0, dataDirectory: join(root, 'app', 'data'), exportsDirectory: join(root, 'app', 'exports'),
              openBrowser: async address => {
                ${openerError ? "throw new Error('SYNTHETIC_OPENER_FAILURE');" : ''}
                assert.match(new URL(address).hash, /^#open=[a-f0-9]{64}$/);
                console.log('SYNTHETIC_BROWSER_REQUEST_OK');
              }
            });
            console.log('SYNTHETIC_SERVER_CREATED');
            console.log(app.origin);
            setTimeout(async () => { await app.close(); process.exit(0); }, 6000);
            return app;
          }
        });
      } catch (error) { console.error(error.message); process.exitCode = 1; }
    `);
  }
  return directory;
}
function launch(directory, envOverrides = {}) {
  const child = spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
    ['/d', '/s', '/c', `""${join(directory, 'Launch BudgetMe.cmd')}""`],
    { cwd: directory, windowsVerbatimArguments: true, env: {
      ...process.env, TEMP: directory, TMP: directory, HOME: directory, USERPROFILE: directory,
      APPDATA: directory, LOCALAPPDATA: directory, XDG_CACHE_HOME: directory, ...envOverrides
    }, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '', sawPause = false;
  child.stdin.on('error', error => { if (error.code !== 'EPIPE') throw error; });
  child.stdout.on('data', bytes => {
    output += bytes.toString();
    if (!sawPause && output.includes('Press any key')) { sawPause = true; child.stdin.write('\n'); }
  });
  child.stderr.on('data', bytes => { output += bytes.toString(); });
  const done = new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      const stop = spawn(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe',
        ['/d', '/c', `taskkill /PID ${child.pid} /T /F`],
        { cwd: directory, env: { ...process.env, TEMP: directory, TMP: directory }, stdio: 'ignore' });
      stop.once('error', reject);
      stop.once('exit', () => reject(new Error(`Owned synthetic cmd launcher ${child.pid} timed out.`)));
    }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolveExit({ code, output, sawPause }); });
  });
  return {
    done,
    async ready() {
      const until = Date.now() + 8000;
      while (Date.now() < until) {
        const url = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
        if (url) return url;
        if (child.exitCode !== null) throw new Error('Synthetic launcher exited before startup: ' + output);
        await new Promise(resolveWait => setTimeout(resolveWait, 30));
      }
      throw new Error('Synthetic launcher did not start its isolated server.');
    }
  };
}

test('actual cmd launcher works with spaces, confined environment and isolated real server', async () => {
  const directory = await fixture();
  const first = launch(directory);
  try {
    const url = new URL(await first.ready());
    const res = await fetch(url.origin + '/api/status', { method: 'POST', headers: {
      Origin: url.origin, 'Content-Type': 'application/json'
    }, body: '{}' });
    assert.equal(res.status, 403);
    assert.equal((await fetch(url.origin + '/')).status, 200);
    const lock = await readFile(join(directory, 'app', 'data', 'process.lock'), 'utf8');
    await new Promise(done => setTimeout(done, 1100));
    const duplicate = await launch(directory).done;
    assert.equal(duplicate.code, 0, duplicate.output);
    assert.ok(duplicate.output.includes('No second server was started'));
    assert.ok(!duplicate.output.includes('SYNTHETIC_SERVER_CREATED'));
    assert.ok(!/#[a-f0-9]{64}|#open=/.test(duplicate.output));
    assert.equal(await readFile(join(directory, 'app', 'data', 'process.lock'), 'utf8'), lock);
    assert.equal((await fetch(url.origin + '/')).status, 200);
    const result = await first.done;
    assert.equal(result.code, 0, result.output);
    assert.ok(result.output.includes('SYNTHETIC_ENVIRONMENT_OK'));
    assert.ok(result.output.includes('This launcher has finished.'));
    assert.ok(result.output.includes('SYNTHETIC_BROWSER_REQUEST_OK'));
    assert.ok(!/#[a-f0-9]{64}|#open=/.test(result.output));
    assert.ok(result.sawPause);
  } finally { await first.done; await rm(directory, { recursive: true, maxRetries: 3, retryDelay: 100 }); }
});
test('cmd launcher preserves missing-app and server-failure errors until acknowledgement', async () => {
  const missing = await fixture(false);
  const broken = await fixture();
  try {
    const missingResult = await launch(missing).done;
    assert.equal(missingResult.code, 1); assert.ok(missingResult.output.includes('app folder is missing')); assert.ok(missingResult.sawPause);
    await writeFile(join(broken, 'app', 'tools', 'launch.mjs'), "console.error('SYNTHETIC_STARTUP_FAILURE'); process.exitCode = 7;");
    const failed = await launch(broken).done;
    assert.equal(failed.code, 1); assert.ok(failed.output.includes('SYNTHETIC_STARTUP_FAILURE')); assert.ok(failed.sawPause);
  } finally { await rm(missing, { recursive: true }); await rm(broken, { recursive: true }); }
});
test('cmd launcher reports a missing Node without installation or hidden failure', async () => {
  const directory = await fixture();
  try {
    const missingNode = await launch(directory, { PATH: 'C:\\Windows\\System32', PATHEXT: '.COM;.EXE;.BAT;.CMD' }).done;
    assert.equal(missingNode.code, 1);
    assert.ok(missingNode.output.includes('Node.js was not found'));
    assert.ok(missingNode.output.includes('No installation was attempted'));
    assert.ok(missingNode.sawPause, missingNode.output);
  } finally { await rm(directory, { recursive: true }); }
});
test('actual cmd opener failure keeps the owned server available and exposes only understandable non-secret errors', async () => {
  const directory = await fixture(true, true);
  const first = launch(directory);
  try {
    const origin = await first.ready();
    assert.equal((await fetch(origin)).status, 200);
    const lock = await readFile(join(directory, 'app', 'data', 'process.lock'), 'utf8');
    await new Promise(done => setTimeout(done, 1100));
    const reopen = await launch(directory).done;
    assert.equal(reopen.code, 1);
    assert.ok(reopen.output.includes('default browser'));
    assert.ok(!reopen.output.includes('SYNTHETIC_SERVER_CREATED'));
    assert.equal(await readFile(join(directory, 'app', 'data', 'process.lock'), 'utf8'), lock);
    assert.equal((await fetch(origin)).status, 200);
    const result = await first.done;
    assert.ok(result.output.includes('local server is still running'));
    assert.ok(!result.output.includes('SYNTHETIC_OPENER_FAILURE'));
    assert.ok(!/#open=[a-f0-9]{64}/.test(result.output + reopen.output));
  } finally { await first.done; await rm(directory, { recursive: true }); }
});
test('actual cmd stale-owner failure preserves the exact lock and never starts a server', async () => {
  const directory = await fixture();
  try {
    await mkdir(join(directory, 'app', 'data'), { recursive: true });
    const path = join(directory, 'app', 'data', 'process.lock');
    const contents = JSON.stringify({ pid: 2147483647, nonce: 'b'.repeat(32), started: new Date().toISOString() });
    await writeFile(path, contents);
    const result = await launch(directory).done;
    assert.equal(result.code, 1);
    assert.ok(result.output.includes('interrupted run'));
    assert.ok(result.output.includes('No existing lock was removed'));
    assert.ok(!result.output.includes('SYNTHETIC_SERVER_CREATED'));
    assert.equal(await readFile(path, 'utf8'), contents);
    assert.ok(result.sawPause);
  } finally { await rm(directory, { recursive: true }); }
});
test('simultaneous actual CMD startup tolerates directory creation races and creates at most one server', async () => {
  const directory = await fixture();
  const launches = [launch(directory), launch(directory)];
  try {
    const results = await Promise.all(launches.map(entry => entry.done));
    assert.equal(results.filter(result => result.output.includes('SYNTHETIC_SERVER_CREATED')).length, 1);
    for (const result of results) {
      assert.ok(result.output.includes('SYNTHETIC_ENVIRONMENT_OK'), result.output);
      assert.ok(!result.output.includes('Cannot create BudgetMe'), result.output);
      assert.ok(result.code === 0 || result.code === 1 && result.output.includes('already opening'), result.output);
      assert.ok(!/#open=[a-f0-9]{64}/.test(result.output));
      assert.ok(result.sawPause);
    }
    assert.equal(results.filter(result => result.output.includes('No second server was started') ||
      result.output.includes('already opening')).length >= 1, true);
  } finally {
    await Promise.all(launches.map(entry => entry.done));
    await rm(directory, { recursive: true });
  }
});
