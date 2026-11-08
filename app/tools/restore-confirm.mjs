export function confirmRestore(prompt) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      prompt.removeListener('SIGINT', cancel);
      prompt.removeListener('close', cancel);
      process.removeListener('SIGINT', cancel);
    };
    const finish = (error, answer) => {
      if (settled) return;
      settled = true; cleanup();
      if (error) reject(error); else resolve(answer);
    };
    const cancel = () => finish(new Error('Restore cancelled; current vault unchanged.'));
    prompt.once('SIGINT', cancel);
    prompt.once('close', cancel);
    process.once('SIGINT', cancel);
    try { prompt.question('Restore this verified backup as the current vault? Type RESTORE: ', answer => finish(null, answer)); }
    catch (error) { finish(error); }
  });
}
