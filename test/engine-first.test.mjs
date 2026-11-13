import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

test('motor de respuestas: la primera pregunta concreta se responde, el saludo recibe la bienvenida y una frase de situación no se confunde con el horario', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-engine-first-')),
    code = randomUUID(),
    password = 'Password-engine-2026!';
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 10000);
    server.stderr.on('data', b => (logs += b));
    server.stdout.on('data', b => {
      const m = String(b).match(/http:\/\/127.0.0.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(Error(logs));
    });
  });
  t.after(async () => {
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
    await rm(dir, { recursive: true, force: true });
  });
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const r = await fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function until(fn, tries = 40) {
    let v;
    for (let i = 0; i < tries; i++) {
      v = await fn();
      if (v) return v;
      await sleep(250);
    }
    return v;
  }
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password,
    inviteCode: code,
  });
  let n = 0;
  // abre una conversación nueva con un cliente nuevo y devuelve lo que contestó el motor al mensaje indicado (índice 0 = primero)
  async function ask(messages) {
    const u = await call('/api/auth/register', '', { username: 'cliente' + ++n, name: 'Cliente ' + n, password });
    const conv = (await call('/api/conversations', u.cookie, { courseId: 'aves', channel: 'whatsapp' })).conversation;
    let last = null;
    for (const [i, text] of messages.entries()) {
      await call(
        '/api/conversations/' + conv.id + '/messages',
        u.cookie,
        { text, clientRef: randomUUID() },
        'POST',
        201,
      );
      last = await until(async () => {
        const bots = (await call('/api/conversations/' + conv.id + '/messages', u.cookie)).messages.filter(
          m => m.sender_kind === 'automation',
        );
        return bots.length >= i + 1 ? bots[i] : null;
      });
      assert.ok(last, 'el motor contesta el mensaje ' + (i + 1));
    }
    await sleep(300);
    const log = (await call('/api/conversations/' + conv.id + '/replies', admin.cookie)).log.find(
      l => l.reply_text === last.text,
    );
    return { text: last.text, log };
  }
  const WELCOME = /Te comparto la información de/,
    SCHEDULE = /Docente:|Fecha:/;

  // 1) primer mensaje con una pregunta concreta: se responde con el conocimiento aprobado, no con la ficha genérica
  const q1 = await ask(['¿Entregan constancia al terminar?']);
  assert.doesNotMatch(q1.text, WELCOME);
  assert.match(q1.text, /certificado/i);
  assert.equal(q1.log.intent, 'certificate');
  assert.ok(q1.log.sources.some(s => s.type === 'knowledge'));
  // 2) un saludo o «me interesa» sigue recibiendo la bienvenida con la ficha
  for (const hi of ['Hola', 'Me interesa el curso']) {
    const r = await ask([hi]);
    assert.match(r.text, WELCOME, hi);
    assert.match(r.log.reason, /bienvenida|ficha/i);
  }
  // 3) primera pregunta que el conocimiento no cubre: no se pierde la bienvenida (antes de este arreglo era el texto genérico)
  const q3 = await ask(['¿Dan beca para estudiantes de veterinaria?']);
  assert.match(q3.text, WELCOME);
  assert.match(q3.log.reason, /Primer mensaje sin respuesta en el conocimiento/);
  // 4) «Qué pasa si un día no puedo conectarme a la sesión?»: es una situación, no una consulta de horario
  const q4 = await ask(['Hola', '¿Qué pasa si un día no puedo conectarme a la sesión?']);
  assert.equal(q4.log.intent, 'unknown');
  assert.doesNotMatch(q4.text, SCHEDULE, 'no responde con la ficha de fechas y docente');
  // 5) las preguntas de horario de verdad siguen resolviéndose con el catálogo
  for (const q of ['¿Cuándo empieza?', '¿Qué día es la primera sesión?', '¿Cuál es el horario?']) {
    const r = await ask(['Hola', q]);
    assert.equal(r.log.intent, 'schedule', q);
    assert.match(r.text, SCHEDULE, q);
  }
  // 6) «un día» suelto ya no dispara el horario
  const q6 = await ask(['Hola', 'Algún día me gustaría estudiar esto, pero ahorita estoy ocupado']);
  assert.notEqual(q6.log.intent, 'schedule');
});
