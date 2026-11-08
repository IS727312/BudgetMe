import { resolve, join, relative, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';
import readline from 'node:readline';
import { ROOT } from '../server.mjs';
import { unlock, atomicFile, acquireLock, exists } from '../lib/vault.mjs';
import { confirmRestore } from './restore-confirm.mjs';

const input = process.argv[2];
if (!input || !process.stdin.isTTY) {
  console.error('Run interactively: node tools\\restore.mjs exports\\<encrypted-backup>.json');
  console.error('Or: node tools\\restore.mjs data\\vault.previous.json');
  process.exitCode = 1;
} else {
  const source = resolve(ROOT, input), rel = relative(ROOT, source);
  let release, key;
  try {
    if (rel.startsWith('..') || isAbsolute(rel) || !source.endsWith('.json')) throw new Error('Backup must be a JSON file inside the app folder.');
    release = await acquireLock(join(ROOT, 'data'));
    const encrypted = await readFile(source, 'utf8');
    process.stdout.write('Backup passphrase (hidden; Enter to submit, Ctrl+C to cancel): ');
    readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    let secret = '';
    const password = await new Promise((resolvePassword, reject) => {
      const listener = (str, keystroke) => {
        if (keystroke.ctrl && keystroke.name === 'c') { cleanup(); reject(new Error('Restore cancelled.')); }
        else if (keystroke.name === 'return') { cleanup(); resolvePassword(secret); }
        else if (keystroke.name === 'backspace') secret = secret.slice(0, -1);
        else if (str && !keystroke.ctrl && !keystroke.meta && secret.length < 128) secret += str;
      };
      const cleanup = () => {
        process.stdin.removeListener('keypress', listener);
        process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n');
      };
      process.stdin.on('keypress', listener);
    });
    const restored = await unlock(encrypted, password);
    key = restored.key; secret = '';
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    let confirmation;
    try { confirmation = await confirmRestore(prompt); }
    finally { prompt.close(); }
    if (confirmation !== 'RESTORE') throw new Error('Restore cancelled; current vault unchanged.');
    const target = join(ROOT, 'data', 'vault.json');
    const hadCurrent = await exists(target);
    if (hadCurrent) await atomicFile(join(ROOT, 'data', 'vault.pre-restore.json'), await readFile(target, 'utf8'));
    await atomicFile(target, encrypted);
    console.log(hadCurrent
      ? 'Verified encrypted backup restored. Previous current vault retained as data\\vault.pre-restore.json.'
      : 'Verified encrypted backup restored. No previous current vault existed.');
  } catch (error) { console.error(`Restore stopped: ${error.message}`); process.exitCode = 1; }
  finally { key?.fill(0); if (release) await release(); }
}
