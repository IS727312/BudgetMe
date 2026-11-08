import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

export class AccessError extends Error {
  constructor(message, status = 503, retryAfter = 0) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export function browserArguments(address) {
  const url = new URL(address);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search ||
      !/^#open=[a-f0-9]{64}$/.test(url.hash)) {
    throw new AccessError('Invalid local browser destination.');
  }
  return ['url.dll,FileProtocolHandler', url.href];
}

export async function openWindowsBrowser(address, root) {
  const args = browserArguments(address);
  if (process.platform !== 'win32') throw new AccessError('Automatic opening requires Windows.');
  const runtime = join(resolve(root), '.runtime');
  const env = { ...process.env };
  for (const part of ['temp', 'home', 'cache', 'appdata', 'localappdata']) {
    await mkdir(join(runtime, part), { recursive: true });
  }
  Object.assign(env, {
    TEMP: join(runtime, 'temp'), TMP: join(runtime, 'temp'),
    HOME: join(runtime, 'home'), USERPROFILE: join(runtime, 'home'),
    APPDATA: join(runtime, 'appdata'), LOCALAPPDATA: join(runtime, 'localappdata'),
    XDG_CACHE_HOME: join(runtime, 'cache'), npm_config_cache: join(runtime, 'cache', 'npm'),
    npm_config_update_notifier: 'false'
  });
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'rundll32.exe');
  await new Promise((done, reject) => {
    const child = spawn(executable, args, {
      cwd: resolve(root), env, shell: false, windowsHide: true,
      stdio: 'ignore', timeout: 8000
    });
    child.once('error', () => reject(new AccessError('Windows could not request the default browser. Check its default-browser settings, then double-click Launch BudgetMe.cmd again.')));
    child.once('exit', code => {
      if (code === 0) done();
      else reject(new AccessError('The default-browser request failed or timed out. Check Windows default-browser settings, then double-click Launch BudgetMe.cmd again.'));
    });
  });
}

export function createAccess({ origin, launchToken, opener, clock = Date.now }) {
  const pending = new Map(), next = new Map();
  let closed = false;
  return {
    async open(source) {
      if (closed || !['http', 'ipc'].includes(source)) throw new AccessError('BudgetMe is stopping. Relaunch after its window closes.');
      const time = clock(), delay = source === 'http' ? 10000 : 1000;
      if (time < (next.get(source) || 0)) {
        throw new AccessError('BudgetMe is already opening. Wait a few seconds before trying again.', 429, Math.ceil((next.get(source) - time) / 1000));
      }
      next.set(source, time + delay);
      let grant = pending.get(source);
      // Repeated triggers cannot invalidate a browser opening that is still in flight.
      if (!grant || grant.expires <= time) {
        grant = { code: randomBytes(32).toString('hex'), expires: time + 60000 };
        pending.set(source, grant);
      }
      try { await opener(`${origin}/#open=${grant.code}`); }
      catch (error) {
        if (error instanceof AccessError) throw error;
        throw new AccessError('Could not request the default browser. Check its Windows settings, then double-click Launch BudgetMe.cmd again.');
      }
      return { requested: true };
    },
    claim(code) {
      const failure = () => new AccessError('This opening request expired or was already used. Click Open BudgetMe or double-click Launch BudgetMe.cmd.', 403);
      if (closed || typeof code !== 'string' || !/^[a-f0-9]{64}$/.test(code)) throw failure();
      for (const [source, grant] of pending) {
        if (timingSafeEqual(Buffer.from(code, 'hex'), Buffer.from(grant.code, 'hex'))) {
          pending.delete(source);
          if (grant.expires <= clock()) throw failure();
          return launchToken;
        }
      }
      throw failure();
    },
    close() { closed = true; pending.clear(); next.clear(); }
  };
}

export function brokerAddress(directory, owner) {
  const path = resolve(directory);
  const digest = createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).update(owner.nonce).digest('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\budgetme-${digest}`
    : join(directory, `reopen-${digest}.sock`);
}

export async function serveReopen(directory, owner, access) {
  const sockets = new Set();
  const broker = net.createServer(socket => {
    if (sockets.size >= 8) { socket.end('{"ok":false,"reason":"busy"}\n'); return; }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => { socket.destroy(); });
    socket.setTimeout(12000, () => socket.destroy());
    let input = '', handled = false;
    socket.on('data', async bytes => {
      if (handled) return;
      input += bytes.toString('utf8');
      if (Buffer.byteLength(input) > 128) { handled = true; socket.end('{"ok":false,"reason":"invalid"}\n'); return; }
      if (!input.includes('\n')) return;
      handled = true;
      let request;
      try { request = JSON.parse(input); }
      catch { socket.end('{"ok":false,"reason":"invalid"}\n'); return; }
      if (!request || Object.keys(request).length !== 1 || request.action !== 'open') {
        socket.end('{"ok":false,"reason":"invalid"}\n'); return;
      }
      try {
        await access.open('ipc');
        socket.end(JSON.stringify({ ok: true, pid: owner.pid, instance: owner.nonce }) + '\n');
      } catch (error) {
        socket.end(JSON.stringify({ ok: false, reason: error instanceof AccessError && error.status === 429 ? 'busy' : 'browser' }) + '\n');
      }
    });
  });
  await new Promise((done, reject) => {
    broker.once('error', reject);
    broker.listen(brokerAddress(directory, owner), () => { broker.removeListener('error', reject); done(); });
  });
  return async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(done => broker.close(done));
  };
}

export function requestReopen(directory, owner) {
  return new Promise((done, reject) => {
    const socket = net.connect(brokerAddress(directory, owner));
    let input = '';
    const fail = error => { socket.destroy(); reject(error); };
    socket.setTimeout(12000, () => fail(new AccessError('The existing BudgetMe instance did not respond. Keep its lock intact; close its original window before restarting.')));
    socket.once('error', fail);
    socket.once('connect', () => socket.write('{"action":"open"}\n'));
    socket.on('data', bytes => {
      input += bytes.toString('utf8');
      if (Buffer.byteLength(input) > 2048) return fail(new AccessError('Invalid response from the existing instance.'));
      if (!input.includes('\n')) return;
      let reply;
      try { reply = JSON.parse(input); }
      catch { return fail(new AccessError('Invalid response from the existing instance.')); }
      socket.end();
      if (!reply.ok) return fail(new AccessError(reply.reason === 'busy'
        ? 'BudgetMe is already opening. Wait a few seconds, then try again.'
        : 'The existing instance could not request its default browser. Check Windows default-browser settings, then try again.'));
      if (reply.pid !== owner.pid || reply.instance !== owner.nonce) return fail(new AccessError('Existing-instance identity mismatch. No second server was started.'));
      done({ requested: true });
    });
    socket.once('end', () => { if (!input.includes('\n')) fail(new AccessError('The existing instance closed its reopen connection. Try again.')); });
  });
}
