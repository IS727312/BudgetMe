import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT } from '../server.mjs';
import { fingerprint } from './fingerprint.mjs';
import { atomicFile } from '../lib/vault.mjs';

const [role, reviewedSha, reviewer, result] = process.argv.slice(2);
if (!['security', 'test'].includes(role) || !reviewer || !result || result.length > 3000 || !/^[a-f0-9]{64}$/.test(reviewedSha || '')) {
  throw new Error('Usage: node tools\\record-review.mjs security|test <reviewed-fingerprint> <actual-reviewer> <actual-passing-result>. This records an actual review; it does not perform one.');
}
const sha = await fingerprint();
if (reviewedSha !== sha) throw new Error('Source changed after review. Obtain a new review, do not reuse the old result.');
const directory = join(ROOT, '.runtime', 'release');
await mkdir(directory, { recursive: true });
const checked = JSON.parse(await readFile(join(directory, 'checks.json'), 'utf8'));
if (checked.fingerprint !== sha || !checked.testsPassed) throw new Error('Run the executable release gate first.');
await atomicFile(join(directory, `${role}.json`), JSON.stringify({ role, fingerprint: sha, reviewer, result, passed: true, at: new Date().toISOString() }, null, 2));
console.log(`${role} review recorded for this source fingerprint. This is a workflow record, not a cryptographic or independent guarantee.`);
