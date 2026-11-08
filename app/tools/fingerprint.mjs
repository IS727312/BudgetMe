import { createHash } from 'node:crypto';
import { SOURCE_PATHS, sourcePath, sourceBytes } from './source-control.mjs';

export async function sourceFiles() {
  return Promise.all(SOURCE_PATHS.filter(path => path.startsWith('app/')).map(sourcePath));
}
export async function fingerprint() {
  const hash = createHash('sha256');
  for (const path of SOURCE_PATHS) hash.update(path).update('\0').update(await sourceBytes(path)).update('\0');
  return hash.digest('hex');
}
