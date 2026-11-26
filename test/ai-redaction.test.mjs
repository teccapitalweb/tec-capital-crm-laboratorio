// Lo que recibe la IA (server/ai-provider.mjs): el texto que escribió la persona viaja sin correos, teléfonos ni números
// largos, como promete el aviso de privacidad; lo del equipo y el conocimiento van tal cual. Anthropic de mentira por
// ANTHROPIC_BASE_URL: sin red ni gasto.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createAiProvider } from '../server/ai-provider.mjs';

test('draft: correos y teléfonos del cliente se ocultan antes de llamar a Claude; el historial del equipo no cambia', async t => {
  const seen = [];
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: '{"answer":"Claro, con gusto.","used_ids":["k1"],"confidence":0.9}' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => stub.close(r)));
  // el SDK lee la clave y la base del entorno del proceso
  const prev = { key: process.env.ANTHROPIC_API_KEY, base: process.env.ANTHROPIC_BASE_URL };
  process.env.ANTHROPIC_API_KEY = 'sk-ant-prueba';
  process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:' + stub.address().port;
  t.after(() => {
    if (prev.key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prev.key;
    if (prev.base === undefined) delete process.env.ANTHROPIC_BASE_URL;
    else process.env.ANTHROPIC_BASE_URL = prev.base;
  });
  const provider = createAiProvider({
    env: {
      AI_PROVIDER: 'claude',
      ANTHROPIC_API_KEY: 'sk-ant-prueba',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + stub.address().port,
    },
    log: { error() {}, warn() {}, info() {} },
  });
  const out = await provider.draft({
    brand: 'GlobalVet',
    course: 'Plan sanitario para aves',
    edition: { name: 'Edición general', dateLabel: 'lunes 30 de noviembre', priceLabel: '599.00 MXN' },
    question: 'mi correo es ana.secreta@example.com, ¿me mandan el temario?',
    knowledge: [{ id: 'k1', question: '¿Mandan el temario?', answer: 'Sí, por este chat.', variants: [] }],
    history: [
      { role: 'customer', text: 'hola, mi tel es 55 1234 5678' },
      { role: 'agent', text: 'Con gusto, ¿me confirmas tu correo? Nuestro tel es 55 9876 5432' },
    ],
  });
  assert.equal(out.text, 'Claro, con gusto.', out.reason || '');
  assert.equal(seen.length, 1);
  const sent = JSON.stringify(seen[0]);
  assert.equal(sent.includes('ana.secreta@example.com'), false);
  assert.equal(sent.includes('55 1234 5678'), false);
  assert.ok(sent.includes('[correo]') && sent.includes('[teléfono]'));
  assert.ok(sent.includes('55 9876 5432'), 'lo que escribió el equipo no se toca');
  assert.ok(sent.includes('¿me mandan el temario?'), 'el resto de la pregunta llega completo');
});
