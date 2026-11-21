import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { similarity, bestMatch } from '../server/ai-provider.mjs';
import { DEMO_KNOWLEDGE } from '../server/replies-schema.mjs';

// Asistente sin callejones (docs/PLAN_ASISTENTE_SIN_CALLEJONES.md): los mensajes de trato no son «preguntas sin respuesta», las respuestas cortas
// se leen contra el último mensaje del asistente, y antes de pasar a una persona se le pregunta.
const OPTIONS = ['Precio', 'Temario', 'Fechas'],
  WITH_HUMAN = ['Precio', 'Fechas', 'Hablar con asesor'],
  OFFER = ['Sí, con un asesor', 'Ver opciones'];

async function start(t, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-asistente-')),
    code = randomUUID(),
    password = 'Password-asistente-2026!';
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
      AI_PROVIDER: '',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
      CHANNEL_CONNECTOR: '',
      ...env,
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
  let db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {}
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
  const admin = await call('/api/auth/register', '', {
    username: 'admin',
    name: 'Administración',
    password,
    inviteCode: code,
  });
  db = new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  // cada persona: perfil nuevo y conversación del curso de aves; say() manda un mensaje y devuelve la decisión y la respuesta a ESE mensaje
  let n = 0;
  const person = async name => {
    const u = await call('/api/auth/register', '', { username: 'persona' + ++n, name, password }),
      conv = (await call('/api/conversations', u.cookie, { courseId: 'aves', channel: 'whatsapp' })).conversation.id;
    const say = async text => {
      const sent = await call(
        '/api/conversations/' + conv + '/messages',
        u.cookie,
        { text, clientRef: randomUUID() },
        'POST',
        201,
      );
      for (let i = 0; i < 80; i++) {
        await sleep(120);
        const log = db.prepare('SELECT * FROM reply_log WHERE trigger_message_id=?').get(sent.id);
        if (log) {
          const m = log.reply_message_id
            ? db.prepare('SELECT * FROM messages WHERE id=?').get(log.reply_message_id)
            : null;
          return { log, text: m?.text || '', buttons: m?.buttons ? JSON.parse(m.buttons) : null };
        }
      }
      assert.fail('sin respuesta a «' + text + '»\n' + logs);
    };
    const state = () => ({ ...db.prepare('SELECT bot_enabled,status FROM conversations WHERE id=?').get(conv) });
    return { conv, say, state };
  };
  const sim = async text => (await call('/api/replies/test', admin.cookie, { brandId: 'globalvet', text })).result;
  return { call, admin, db, person, sim };
}

test('parecido con el conocimiento: una palabra de relleno o un trozo corto no bastan para contestar', () => {
  const kb = DEMO_KNOWLEDGE.map((k, i) => ({ ...k, id: 'k' + i }));
  for (const text of [
    'entiendo',
    'tienen sucursal',
    'tienen becas',
    'tienen más cursos',
    'a ver',
    'nada más',
    'no entiendo',
  ])
    assert.equal(bestMatch(text, kb), null, '«' + text + '» no debe contestarse con el conocimiento');
  // lo que sí coincidía sigue coincidiendo: la palabra de relleno suma cuando otra con contenido también coincide
  assert.ok(similarity('¿Entregan constancia al terminar?', kb[0]) >= 0.5);
  assert.equal(
    similarity('¿Tienen estacionamiento?', { question: '¿Tienen estacionamiento?', variants: [], topic: 'sede' }),
    1,
  );
  assert.equal(
    similarity('¿Tienen cafetería?', { question: '¿Tienen estacionamiento?', variants: [], topic: 'sede' }),
    0,
  );
});

test('mensajes de trato: «ok», «sí», «no», «espera», «¿eres un bot?»… tienen su respuesta y no cuentan como pregunta sin respuesta', async t => {
  const { sim, db } = await start(t);
  const BANK = [
    ['Disculpa', 'help'],
    ['ok', 'thanks'],
    ['okey', 'thanks'],
    ['entiendo', 'thanks'],
    ['de acuerdo', 'thanks'],
    ['👍', 'thanks'],
    ['jaja', 'thanks'],
    ['eso es todo', 'thanks'],
    ['va', 'affirm'],
    ['sí', 'affirm'],
    ['claro', 'affirm'],
    ['si quiero', 'affirm'],
    ['no', 'decline'],
    ['no gracias', 'decline'],
    ['ya no me interesa', 'decline'],
    ['ahorita no', 'decline'],
    ['no quiero inscribirme todavía', 'decline'],
    ['espera', 'later'],
    ['un momento', 'later'],
    ['lo voy a pensar', 'later'],
    ['luego te aviso', 'later'],
    ['mañana te escribo', 'later'],
    ['bye', 'bye'],
    ['hasta luego', 'bye'],
    ['?', 'help'],
    ['mmm', 'help'],
    ['una pregunta', 'help'],
    ['tengo una duda', 'help'],
    ['me puedes ayudar', 'help'],
    ['siguen ahí', 'help'],
    ['nadie contesta', 'help'],
    ['no entiendo', 'help'],
    ['otra vez', 'help'],
    ['a ver', 'help'],
    ['ver opciones', 'menu'],
    ['informes', 'greeting'],
    ['quiero saber más', 'greeting'],
    ['de qué trata', 'syllabus'],
    ['quién eres', 'identity'],
    ['eres un bot', 'identity'],
    ['¿eres una persona?', 'identity'],
    ['dónde están ubicados', 'modality'],
    ['es en vivo', 'modality'],
    ['está caro', 'objection'],
    ['no me alcanza', 'objection'],
    ['qué otros cursos tienen', 'courses'],
    ['hay cupo', 'seats'],
    ['todavía hay lugar', 'seats'],
    // lo de siempre no se movió
    ['¿eres un bot? ponme con un asesor', 'human'],
    ['eres bot? dame un humano', 'human'],
    ['ya pagué pero la comisión estuvo cara', 'payment'],
    ['¿y si no me alcanza el tiempo para las clases?', 'unknown'],
    ['devuélvanme mi dinero', 'refund'],
    ['ya no quiero el curso y quiero mi dinero', 'refund'],
    ['no quiero quedarme sin lugar, quiero inscribirme', 'enroll'],
    ['un momento antes de la sesión no puedo conectarme', 'unknown'],
    ['quiero hablar con una persona real', 'human'],
    ['Quiero inscribirme', 'enroll'],
    ['¿cuánto cuesta?', 'price'],
    ['ok y cuánto cuesta', 'price'],
    ['Hola, ¿qué temas incluye?', 'syllabus'],
    ['asesor', 'human'],
    ['Sí, con un asesor', 'human'],
    // preguntas de verdad: siguen yendo al conocimiento o a la IA, no a una regla
    ['¿es para principiantes?', 'unknown'],
    ['tienen becas', 'unknown'],
    ['tengo una duda, ¿mi hijo de 15 años puede tomarlo?', 'unknown'],
  ];
  const wrong = [];
  for (const [text, intent] of BANK) {
    const r = await sim(text);
    if (r.intent !== intent) wrong.push(text + ' → «' + r.intent + '», esperaba «' + intent + '»');
    else if (!['human', 'enroll', 'refund', 'payment'].includes(intent) && r.handoff)
      wrong.push(text + ' → pasa a una persona');
  }
  assert.deepEqual(wrong, []);
  // textos: honestos y con datos del catálogo
  const bot = await sim('¿eres un bot?');
  assert.match(bot.reply, /Soy el asistente automático de GlobalVet/);
  assert.match(bot.reply, /«asesor»/);
  assert.deepEqual(bot.buttons, WITH_HUMAN);
  const caro = await sim('está muy caro');
  assert.match(caro.reply, /El precio vigente de .* es de \$/);
  assert.match(caro.reply, /no puedo ofrecerte otro precio/);
  assert.doesNotMatch(caro.reply, /te hago|descuento/i);
  assert.equal(caro.handoff, false);
  const otros = await sim('¿qué otros cursos tienen?');
  assert.match(otros.reply, /En GlobalVet también tenemos:\n• Plan sanitario para aves/);
  for (const k of db.prepare("SELECT title FROM courses WHERE brand_id!='globalvet'").all())
    assert.ok(!otros.reply.includes(k.title), 'no se ofrecen cursos de otra marca: ' + k.title);
  const cupo = await sim('¿todavía hay lugar?');
  assert.match(cupo.reply, /Todavía hay lugar|inscripciones .* están abiertas/);
  assert.doesNotMatch(cupo.reply, /^Sí/, '«¿ya se llenó?» no debe contestarse con un «Sí»');
  assert.equal(
    (await sim('ya pagué pero la comisión estuvo cara')).handoff,
    true,
    'un pago reportado siempre pasa a una persona',
  );
  assert.doesNotMatch(cupo.reply, /apartad|reservad/);
  assert.deepEqual((await sim('?')).buttons, WITH_HUMAN);
  assert.deepEqual((await sim('ver opciones')).buttons, OPTIONS);
  // ninguna de estas se contesta ya con una entrada equivocada del conocimiento
  for (const text of ['entiendo', 'tienen sucursal', 'a ver', 'nada más'])
    assert.doesNotMatch((await sim(text)).reason, /Conocimiento aprobado «¿(Entregan|Qué necesito|Si no puedo)/, text);
});

test('sin respuesta: primero opciones, luego se PREGUNTA si quiere una persona y sólo al final se pasa; «sí» y «no» se leen contra el último mensaje', async t => {
  const { person, db } = await start(t);
  // 1) trato y escalones
  const ana = await person('Ana Pérez');
  assert.equal((await ana.say('Hola')).log.intent, 'greeting');
  // la bienvenida pregunta «¿…el temario, el precio o cómo inscribirte?»: un «ok» ahí NO es una inscripción
  const ok1 = await ana.say('ok'),
    ok2 = await ana.say('ok');
  assert.equal(ok1.log.intent, 'thanks');
  assert.equal(ok1.log.action, 'replied');
  assert.match(ok1.text, /Con gusto, Ana/);
  assert.equal(ok2.text, '¡Perfecto! Cualquier cosa, aquí estoy.', 'el segundo «ok» no repite el mismo texto');
  const q = await ana.say('?');
  assert.equal(q.log.intent, 'help');
  assert.deepEqual(q.buttons, WITH_HUMAN);
  const miss1 = await ana.say('xyzzy plugh');
  assert.equal(miss1.log.intent, 'unknown');
  assert.equal(miss1.log.action, 'replied');
  assert.match(miss1.text, /todavía no la tengo a la mano/);
  assert.deepEqual(miss1.buttons, WITH_HUMAN);
  const lost = await ana.say('no entiendo');
  assert.equal(lost.log.intent, 'help');
  assert.equal(lost.log.action, 'replied');
  // segunda sin respuesta (el «no entiendo» de en medio ni suma ni reinicia): se le pregunta, no se le pasa
  const miss2 = await ana.say('qwerty asdf');
  assert.equal(miss2.log.action, 'replied');
  assert.match(miss2.text, /¿Quieres que te pase con una persona del equipo/);
  assert.deepEqual(miss2.buttons, OFFER);
  assert.deepEqual(ana.state(), { bot_enabled: 1, status: 'open' });
  // «no»: no quiere una persona → opciones, y la cuenta empieza de nuevo
  const no = await ana.say('no');
  assert.equal(no.log.intent, 'menu');
  assert.match(no.log.reason, /No quiso pasar con una persona/);
  assert.deepEqual(no.buttons, OPTIONS);
  assert.deepEqual(ana.state(), { bot_enabled: 1, status: 'open' });
  const miss3 = await ana.say('zxcvb mnbvc');
  assert.match(miss3.text, /todavía no la tengo a la mano/);
  assert.equal(miss3.log.action, 'replied');
  const miss4 = await ana.say('poiuy lkjhg');
  assert.deepEqual(miss4.buttons, OFFER);
  // «sí»: acepta → ahora sí pasa a una persona
  const yes = await ana.say('sí');
  assert.equal(yes.log.intent, 'human');
  assert.equal(yes.log.action, 'escalated');
  assert.match(yes.log.reason, /Aceptó la propuesta de hablar con una persona/);
  assert.match(yes.text, /un asesor te escribe por aquí/);
  assert.deepEqual(ana.state(), { bot_enabled: 0, status: 'waiting' });

  // 2) tres sin respuesta seguidas, sin contestar la propuesta: se pasa a una persona con el texto nuevo
  const teo = await person('Teo Ruiz');
  await teo.say('Hola');
  await teo.say('aaaa bbbb');
  const offer = await teo.say('cccc dddd');
  assert.deepEqual(offer.buttons, OFFER);
  const out = await teo.say('eeee ffff');
  assert.equal(out.log.action, 'escalated');
  assert.match(out.text, /Para no hacerte dar más vueltas, le paso tu conversación a una persona del equipo/);
  assert.equal(out.buttons, null);
  assert.deepEqual(teo.state(), { bot_enabled: 0, status: 'waiting' });
  // el botón de la propuesta también pasa a una persona
  // después de un pase a una persona, si el chat vuelve al asistente, la cuenta empieza de cero (no se salta la pregunta)
  db.prepare("UPDATE conversations SET bot_enabled=1,status='open',assigned_to=NULL WHERE id=?").run(teo.conv);
  const fresh = await teo.say('gggg hhhh');
  assert.equal(fresh.log.action, 'replied');
  assert.match(fresh.text, /todavía no la tengo a la mano/);
  const eva = await person('Eva Gil');
  await eva.say('Hola');
  await eva.say('aaaa bbbb');
  await eva.say('cccc dddd');
  const btn = await eva.say('Sí, con un asesor');
  assert.equal(btn.log.intent, 'human');
  assert.equal(btn.log.action, 'escalated');

  // 3) «sí» después de «¿Te cuento el precio o las fechas?» contesta las dos cosas; un «ok» después del precio NO inscribe
  const luis = await person('Luis Mora');
  await luis.say('Hola');
  const tem = await luis.say('temario');
  assert.match(tem.text, /¿Te cuento el precio o las fechas\?$/);
  const both = await luis.say('sí');
  assert.equal(both.log.intent, 'price');
  assert.match(both.log.reason, /^Respondió que sí a lo que ofrecía el mensaje anterior \(price, schedule\)/);
  assert.match(both.text, /El precio de /);
  assert.match(both.text, /• Inicio: /);
  const ack = await luis.say('ok');
  assert.equal(ack.log.intent, 'thanks');
  assert.equal(ack.log.action, 'replied');
  assert.deepEqual(luis.state(), { bot_enabled: 1, status: 'open' });
  // 4) «sí» después de «¿Quieres apartar tu lugar?» sigue el camino de la inscripción (sin venta activa: lo completa una persona, como «Quiero inscribirme»);
  //    «ok», «va» o «vale» ahí sólo acusan recibo: no arman una inscripción
  // (sin fecha publicada, la respuesta de fechas ofrece «el precio o el temario»: un «sí» contesta esas dos)
  const sol = await person('Sol Rey');
  await sol.say('Hola');
  const nodate = await sol.say('fechas');
  assert.match(nodate.text, /¿te cuento el precio o el temario\?$/);
  const two = await sol.say('claro');
  assert.match(two.log.reason, /\(price, syllabus\)/);
  assert.match(two.text, /El precio de /);
  assert.match(two.text, /Esto es lo que verás/);
  db.prepare("UPDATE editions SET starts_at=?,ends_at=? WHERE course_id='aves'").run(
    Date.now() + 30 * 86400e3,
    Date.now() + 30 * 86400e3 + 7200e3,
  ); // la edición ya tiene fecha
  const mar = await person('Mar Soto');
  await mar.say('Hola');
  const dates = await mar.say('fechas');
  assert.match(dates.text, /¿Quieres apartar tu lugar\?/);
  for (const soft of ['ok', 'va', 'vale']) {
    const r = await mar.say(soft);
    assert.notEqual(r.log.intent, 'enroll', soft);
    assert.equal(r.log.action, 'replied', soft);
  }
  assert.deepEqual(mar.state(), { bot_enabled: 1, status: 'open' });
  assert.match((await mar.say('fechas')).text, /¿Quieres apartar tu lugar\?/);
  const go = await mar.say('sí');
  assert.equal(go.log.intent, 'enroll');
  assert.match(go.log.reason, /^Respondió que sí a la invitación a inscribirse/);
  assert.match(go.text, /Anoté tu interés/);
  assert.equal(go.log.action, 'escalated');
  // «sí quiero» justo después del precio (que invita a inscribirse sin preguntar) también
  const paz = await person('Paz Lara');
  await paz.say('Hola');
  await paz.say('precio');
  const want = await paz.say('sí quiero');
  assert.equal(want.log.intent, 'enroll');
  // «no» después de una pregunta cualquiera: se despide sin insistir y sin mandar la ficha
  const noe = await person('Noé Vera');
  await noe.say('Hola');
  await noe.say('temario');
  const bye = await noe.say('no gracias');
  assert.equal(bye.log.intent, 'decline');
  assert.match(bye.text, /^Sin problema, Noé\./);
  assert.equal(bye.log.action, 'replied');
  const gone = await noe.say('ya no me interesa');
  assert.equal(gone.log.intent, 'decline');
  assert.doesNotMatch(gone.text, /Inicio:/, 'no se le manda la ficha a quien ya no le interesa');
  // 5) primer mensaje: una pregunta de trato con respuesta propia se contesta tal cual; un «disculpa» recibe la bienvenida
  const ivo = await person('Ivo Paz'),
    who = await ivo.say('¿eres un bot?');
  assert.equal(who.log.intent, 'identity');
  assert.match(who.text, /Soy el asistente automático/);
  assert.deepEqual(who.buttons, WITH_HUMAN);
  const lia = await person('Lía Ros'),
    hi = await lia.say('Disculpa');
  assert.equal(hi.log.intent, 'help');
  assert.match(hi.text, /• Inicio: /, 'bienvenida con la ficha');
});

test('modo autónomo: las preguntas que la IA sí contesta no cuentan para pasar a una persona; las que no, siguen los tres escalones', async t => {
  // Anthropic de mentira (el SDK respeta ANTHROPIC_BASE_URL): cita una entrada del conocimiento recibido, o devuelve algo que el validador rechaza
  let answer = 'Sí: el curso es en línea, así que puedes tomarlo desde cualquier lugar con conexión a internet.',
    calls = 0;
  const stub = createServer((req, res) => {
    let raw = '';
    req.on('data', c => (raw += c));
    req.on('end', () => {
      calls++;
      const body = JSON.parse(raw),
        id = (String(body.system).match(/\[([0-9a-f-]{36})\] P:/) || [])[1];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'msg_' + calls,
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5-5',
          content: [{ type: 'text', text: JSON.stringify({ answer, used_ids: [id], confidence: 0.9 }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 300, output_tokens: 60 },
        }),
      );
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => stub.close(r)));
  const { call, admin, person } = await start(t, {
    AI_PROVIDER: 'claude',
    ANTHROPIC_API_KEY: 'sk-ant-prueba-local',
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:' + stub.address().port,
    AI_MONTHLY_CALL_LIMIT: '50',
    AI_MONTHLY_TOKEN_LIMIT: '',
  });
  const rs = (await call('/api/replies/settings', admin.cookie)).settings.find(x => x.brand_id === 'globalvet');
  await call(
    '/api/replies/brands/globalvet',
    admin.cookie,
    { mode: 'autonomous', providerEnabled: true, expectedRevision: rs.revision },
    'PATCH',
  );
  const ana = await person('Ana Pérez');
  await ana.say('Hola');
  // tres preguntas seguidas que contesta la IA: ninguna pasa a una persona (antes, la segunda ya escalaba)
  for (const text of [
    'Vivo en Colombia, ¿puedo tomar el curso desde allá?',
    '¿Sirve si trabajo en otro estado de la república y viajo mucho?',
    '¿Y si me mudo a Perú a medio curso puedo seguir tomando el curso?',
  ]) {
    const r = await ana.say(text);
    assert.equal(r.log.intent, 'unknown', text);
    assert.match(r.log.reason, /^Proveedor de IA:/, text);
    assert.equal(r.log.action, 'replied', text);
    assert.match(r.text, /^Sí: el curso es en línea/);
    assert.equal(r.buttons, null, 'una respuesta de la IA no lleva los botones de «no la tengo»');
    assert.ok(JSON.parse(r.log.sources).some(s => s.type === 'knowledge'));
    assert.ok(!r.log.sources.includes('offer_human'));
  }
  assert.equal(calls, 3);
  assert.deepEqual(ana.state(), { bot_enabled: 1, status: 'open' });
  // ahora la IA devuelve algo inválido (un precio): eso sí es «sin respuesta», y arranca desde el primer escalón
  answer = 'El curso cuesta $500 pesos y lo puedes tomar desde cualquier lugar.';
  const m1 = await ana.say('¿Sirve si trabajo en otro estado de la república y viajo mucho?');
  assert.match(m1.log.reason, /Proveedor descartado/);
  assert.match(m1.text, /todavía no la tengo a la mano/);
  assert.deepEqual(m1.buttons, WITH_HUMAN);
  assert.equal(m1.log.action, 'replied');
  const m2 = await ana.say('¿Y si me mudo a Perú a medio curso puedo seguir tomando el curso?');
  assert.deepEqual(m2.buttons, OFFER);
  assert.equal(m2.log.action, 'replied');
  assert.ok(m2.log.sources.includes('offer_human'));
  // con la propuesta hecha, si la IA sí contesta la siguiente, la respuesta sale limpia y la cuenta se reinicia
  answer = 'Sí: el curso es en línea, así que puedes tomarlo desde cualquier lugar con conexión a internet.';
  const back = await ana.say('Vivo en Colombia, ¿puedo tomar el curso desde allá?');
  assert.match(back.log.reason, /^Proveedor de IA:/);
  assert.equal(back.log.action, 'replied');
  assert.equal(back.buttons, null);
  assert.ok(!back.log.sources.includes('offer_human'));
  answer = 'El curso cuesta $500 pesos.';
  const again = await ana.say('¿Sirve si trabajo en otro estado de la república y viajo mucho?');
  assert.match(again.text, /todavía no la tengo a la mano/, 'tras una respuesta buena la cuenta vuelve a empezar');
  assert.deepEqual(ana.state(), { bot_enabled: 1, status: 'open' });
});
