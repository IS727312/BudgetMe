import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { AccessError, requestReopen } from './access.mjs';

async function readOwner(directory) {
  const text = await readFile(join(directory, 'process.lock'), 'utf8');
  let owner;
  try { owner = JSON.parse(text); }
  catch { throw new AccessError('The ownership file is incomplete. No lock was removed. Try again after startup finishes.'); }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 ||
      typeof owner.nonce !== 'string' || !/^[a-f0-9]{32}$/.test(owner.nonce)) {
    throw new AccessError('The ownership file is invalid. Follow the recovery guide; do not delete an active lock.');
  }
  return owner;
}

export async function startOrReopen({ directory, factory }) {
  const deadline = Date.now() + 2500;
  for (;;) {
    let owner;
    try { owner = await readOwner(directory); }
    catch (error) {
      if (error.code === 'ENOENT') {
        try { return { created: true, app: await factory() }; }
        catch (startError) {
          // Two simultaneous launchers can both observe no lock. Only the winner starts.
          if (Date.now() < deadline && startError.message?.startsWith('Data is locked by another instance')) { await wait(100); continue; }
          throw startError;
        }
      }
      if (error instanceof AccessError && Date.now() < deadline) { await wait(100); continue; }
      throw error;
    }
    try { process.kill(owner.pid, 0); }
    catch (error) {
      if (error.code === 'ESRCH') throw new AccessError('An interrupted run left an ownership lock. Follow app\\README.md recovery steps; no lock was removed and no second server was started.');
      throw new AccessError('Cannot verify the existing owner. No lock was removed and no second server was started.');
    }
    try { await requestReopen(directory, owner); return { created: false }; }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code) && Date.now() < deadline) { await wait(100); continue; }
      if (error instanceof AccessError) throw error;
      throw new AccessError('The existing server cannot reopen this version. Close its original window before relaunching; no lock was removed.');
    }
  }
}

export async function runLauncher(options) {
  const result = await startOrReopen(options);
  if (!result.created) {
    console.log('Requested the running BudgetMe app in your default browser. No second server was started.');
    return result;
  }
  const app = result.app;
  console.log('BudgetMe is local-only. Keep this window open; Ctrl+C stops it.');
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  try {
    await app.requestOpen('ipc');
    console.log('Requested BudgetMe in your default browser. Unlock with your vault passphrase.');
  } catch (error) {
    console.error(error instanceof AccessError ? error.message : 'The browser request failed. Check Windows default-browser settings.');
    console.error('The local server is still running. Double-click Launch BudgetMe.cmd to try opening again.');
  }
  return result;
}
