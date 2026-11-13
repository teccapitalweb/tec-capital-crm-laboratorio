import { spawn } from 'node:child_process';

// Arranca el servidor real sobre un directorio de datos y espera a que anuncie su dirección.
// Devuelve { origin, child, logs(), stop() }; quien lo llama es responsable de llamar a stop() (por ejemplo en t.after).
export async function startServer({ dir, env = {}, timeoutMs = 15000 }) {
  let logs = '';
  const child = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, HOST: '127.0.0.1', PORT: '0', DATA_DIR: dir, APP_ORIGIN: '', NODE_ENV: 'test', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', chunk => (logs += chunk));
  const stop = () =>
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise(done => {
          child.once('exit', done);
          child.kill();
        });
  try {
    const origin = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('El servidor no arrancó a tiempo.\n' + logs)), timeoutMs);
      let out = '';
      child.stdout.on('data', chunk => {
        out += chunk;
        const found = out.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (found) {
          clearTimeout(timer);
          resolve(found[0]);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(Error('El servidor terminó al arrancar.\n' + logs));
      });
    });
    return { origin, child, logs: () => logs, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
