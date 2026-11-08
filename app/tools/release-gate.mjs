import { spawnSync } from 'node:child_process';
import { readFile, mkdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { ROOT } from '../server.mjs';
import { fingerprint, sourceFiles } from './fingerprint.mjs';
import { atomicFile } from '../lib/vault.mjs';
import { assertSourceIndex } from './source-control.mjs';

const directory = join(ROOT, '.runtime', 'release');
await mkdir(directory, { recursive: true });
for (const name of ['temp', 'home', 'cache', 'appdata', 'localappdata']) await mkdir(join(ROOT, '.runtime', name), { recursive: true });
const env = {
  ...process.env, TEMP: join(ROOT, '.runtime', 'temp'), TMP: join(ROOT, '.runtime', 'temp'),
  HOME: join(ROOT, '.runtime', 'home'), USERPROFILE: join(ROOT, '.runtime', 'home'),
  APPDATA: join(ROOT, '.runtime', 'appdata'), LOCALAPPDATA: join(ROOT, '.runtime', 'localappdata'),
  XDG_CACHE_HOME: join(ROOT, '.runtime', 'cache'), GIT_CONFIG_GLOBAL: 'NUL', GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0', npm_config_cache: join(ROOT, '.runtime', 'cache')
};
const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
const beforeTests = await fingerprint();
if (manifest.dependencies || manifest.devDependencies || manifest.optionalDependencies) throw new Error('Dependencies require the user-approved package research gate first.');
let checks = 0;
const files = await sourceFiles();
for (const path of files) {
  const name = relative(ROOT, path), source = await readFile(path, 'utf8');
  if (/\.(mjs|js)$/.test(name)) {
    const imports = [...source.matchAll(/^\s*import\s+(?:[^'"\n]+\s+from\s+)?['"]([^'"]+)['"]/gm),
      ...source.matchAll(/\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) if (!specifier.startsWith('.') && !specifier.startsWith('node:')) throw new Error(`Non-built-in import in ${name}.`);
    const checked = spawnSync(process.execPath, ['--check', path], { cwd: ROOT, env, encoding: 'utf8' });
    if (checked.status !== 0) throw new Error(checked.stderr); checks++;
  }
  if (/^public[\\]/.test(name)) {
    const withoutSVGNamespace = source.replaceAll('http://www.w3.org/2000/svg', '');
    if (/https?:\/\/|(?:src|href)\s*=\s*["'](?:\/\/|https?:)|\b(?:eval|innerHTML|insertAdjacentHTML|sendBeacon)\s*[=(]/i.test(withoutSVGNamespace)) {
      throw new Error(`External asset or unsafe DOM primitive in ${name}.`);
    }
  }
}
await assertSourceIndex({ complete: process.argv.includes('--publication') });
const tests = files.filter(path => /^test[\\/].*\.test\.mjs$/.test(relative(ROOT, path)));
const tested = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 });
process.stdout.write(tested.stdout || ''); process.stderr.write(tested.stderr || '');
if (tested.status !== 0) throw new Error('Synthetic release tests failed.');
const sha = await fingerprint();
if (sha !== beforeTests) throw new Error('Source changed during the executable release gate.');
const report = { version: manifest.version, fingerprint: sha, at: new Date().toISOString(), syntaxFiles: checks, testsPassed: true, dependencies: 0 };
await atomicFile(join(directory, 'checks.json'), JSON.stringify(report, null, 2));
console.log(`Source fingerprint: ${sha}`);
console.log('Executable tests/static gate passed. Independent Security Agent and Test Agent attestations are still required for publication.');
if (process.argv.includes('--publication')) {
  for (const role of ['security', 'test']) {
    let review;
    try { review = JSON.parse(await readFile(join(directory, `${role}.json`), 'utf8')); }
    catch { throw new Error(`Missing ${role} reviewer attestation. Run the requested reviewer; do not fabricate one.`); }
    if (review.fingerprint !== sha || review.passed !== true || !review.reviewer || !review.result) throw new Error(`Stale or failing ${role} review. Review this source version again.`);
  }
  const browser = JSON.parse(await readFile(join(directory, 'browser.json'), 'utf8'));
  if (browser.fingerprint !== sha || browser.passed !== true) throw new Error('Real browser test is missing or stale.');
  console.log('All fingerprint-bound publication gates passed. This does not authorize a commit or push.');
}
