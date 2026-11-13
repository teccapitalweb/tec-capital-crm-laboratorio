#!/usr/bin/env node
// npm run check: descubre los archivos y ejecuta, en orden, codificación → sintaxis → formato.
// Un paso suelto: `npm run check -- syntax` (o encoding, format).
import { readdirSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { availableParallelism } from 'node:os';

const DIRS = ['server', 'public', 'test', 'scripts', 'shared'];
const SKIP = new Set(['node_modules', 'vendor', 'flyers', 'fixtures']);

const walk = dir =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? (SKIP.has(entry.name) ? [] : walk(join(dir, entry.name))) : [join(dir, entry.name)],
  );

// Lista de archivos de código que se revisan; exportada para poder comprobarla desde fuera.
export function discover() {
  return DIRS.filter(dir => existsSync(dir))
    .flatMap(walk)
    .filter(file => ['.mjs', '.js'].includes(extname(file)))
    .map(file => file.replace(/\\/g, '/'))
    .sort();
}

const only = process.argv[2];
const wanted = name => !only || only === name;
const report = (name, ok, started, detail = '') => {
  console.log(`${ok ? 'ok   ' : 'FALLO'} ${name}${detail} (${Date.now() - started} ms)`);
  if (!ok) process.exit(1);
};
// `npx` necesita un intérprete de órdenes en Windows; el propio Node no (y su ruta puede llevar espacios).
const run = (command, args, shell = false) => spawnSync(command, args, { stdio: 'inherit', shell }).status === 0;

async function syntax(files) {
  const failed = [];
  await new Promise(done => {
    let next = 0;
    let active = 0;
    const pump = () => {
      if (next >= files.length && !active) return done();
      while (active < availableParallelism() && next < files.length) {
        const file = files[next++];
        active++;
        let stderr = '';
        const child = spawn(process.execPath, ['--check', file], { stdio: ['ignore', 'ignore', 'pipe'] });
        child.stderr.on('data', chunk => (stderr += chunk));
        child.on('exit', code => {
          if (code) failed.push(file + '\n' + stderr);
          active--;
          pump();
        });
      }
    };
    pump();
  });
  return failed;
}

if (import.meta.main) {
  if (wanted('encoding')) {
    const started = Date.now();
    report('encoding', run(process.execPath, ['scripts/check-encoding.mjs']), started);
  }
  if (wanted('syntax')) {
    const started = Date.now();
    const files = discover();
    const failed = await syntax(files);
    if (failed.length) console.error(failed.join('\n'));
    report('syntax', !failed.length, started, `: ${files.length} archivos`);
  }
  if (wanted('format') && existsSync('node_modules/prettier')) {
    const started = Date.now();
    report('format', run('npx', ['prettier', '--check', '.'], process.platform === 'win32'), started);
  }
}
