import { join } from 'node:path';
import { createBudgetServer, ROOT } from '../server.mjs';
import { runLauncher } from '../lib/startup.mjs';
import { AccessError } from '../lib/access.mjs';
import { VaultError } from '../lib/vault.mjs';

try {
  await runLauncher({ directory: join(ROOT, 'data'), factory: () => createBudgetServer() });
} catch (error) {
  console.error(error instanceof AccessError || error instanceof VaultError
    ? error.message
    : `BudgetMe could not start (${error.code || 'INTERNAL'}). No alternate public address will be used.`);
  process.exitCode = 1;
}
