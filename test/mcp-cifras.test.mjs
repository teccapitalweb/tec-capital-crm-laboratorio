// Conector de Claude: «Explícame mis números» (docs/PLAN_MCP_CLAUDE.md, «Cifras y resultados»). Permiso propio, sólo
// agregados de la marca de la llave, regla «menos de 3», periodo validado y nada de datos personales en ninguna salida.
// Las cifras esperadas se calculan aquí a partir de lo que se sembró, no con el mismo código.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, invalid } from '../server/mcp.mjs';
import {
  INSIGHTS_SCOPE,
  INSIGHT_ROUTES,
  INSIGHT_TOOLS,
  OTHER_REASONS,
  lostReasons,
} from '../server/lib/mcp-insights.mjs';
import { FEW, createRouteCaller, people } from '../server/lib/mcp-call.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const allowed = createRouteCaller({ routes: INSIGHT_ROUTES }).allowed;

test('cifras: permiso propio, sólo lecturas y regla «menos de 3»', () => {
  assert.deepEqual(INSIGHT_TOOLS.map(t => t.name).sort(), [
    'cifras_atencion',
    'cifras_ventas',
    'que_le_falta_a_la_marca',
    'rendimiento_recorridos',
    'resultados_difusiones',
    'resultados_evaluacion',
    'resultados_secuencias',
    'resumen_semana',
    'salud_whatsapp',
  ]);
  for (const t of INSIGHT_TOOLS) {
    assert.equal(t.scope, INSIGHTS_SCOPE, t.name);
    assert.equal(t.annotations.readOnlyHint, true, t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.ok(TOOLS.includes(t), 'el conector la anuncia');
  }
  assert.ok(
    INSIGHT_ROUTES.every(([, method]) => method === 'GET'),
    'sólo lecturas',
  );
  for (const [name, path] of [
    ['chatflows', '/api/chatflows'],
    ['chatflows', '/api/chatflows/f-1/analytics'],
    ['sequences', '/api/sequences/s-1/results'],
    ['broadcasts', '/api/broadcasts'],
    ['wa-costs', '/api/wa-costs/meter'],
  ])
    assert.ok(allowed(name, 'GET', path), path);
  for (const [name, method, path] of [
    ['chatflows', 'GET', '/api/chatflows/f-1/sessions'],
    ['chatflows', 'GET', '/api/chatflows/f-1/log'],
    ['sequences', 'GET', '/api/sequences/s-1/enrollments'],
    ['broadcasts', 'GET', '/api/broadcasts/b-12345678/recipients'],
    ['audiences', 'GET', '/api/audiences/x/members'],
    ['broadcasts', 'POST', '/api/broadcasts'],
    ['wa-costs', 'POST', '/api/wa-costs/rates'],
    ['chatflows', 'GET', '/api/chatflows/f-1/analytics/../sessions'],
  ])
    assert.equal(allowed(name, method, path), false, method + ' ' + path);
  // la regla: 1 y 2 se ocultan; 0 y 3 o más se muestran
  assert.deepEqual([0, 1, 2, 3, 40].map(people), [0, FEW, FEW, 3, 40]);
  // motivos de pérdida escritos a mano: el texto sólo sale si lo comparten 3 o más; los demás, juntos y con la regla
  const leak = 'Ana Pérez (tel 5512345678) dice que su esposo no la deja';
  assert.deepEqual(
    lostReasons(
      new Map([
        ['Precio', 4],
        [leak, 1],
        ['Horario', 2],
        ['Sin motivo', 1],
      ]),
    ),
    [
      { motivo: 'Precio', cantidad: 4 },
      { motivo: 'Sin motivo', cantidad: FEW },
      { motivo: OTHER_REASONS, cantidad: 3 },
    ],
  );
  assert.deepEqual(lostReasons(new Map([[leak, 1]])), [{ motivo: OTHER_REASONS, cantidad: FEW }]);
  // el periodo es parte del esquema
  const sales = INSIGHT_TOOLS.find(t => t.name === 'cifras_ventas').inputSchema;
  assert.equal(invalid(sales, { desde: '2026-01-01', hasta: '2026-01-31', agrupar: 'mes' }), null);
  assert.match(invalid(sales, { agrupar: 'hora' }), /sólo admite/);
  assert.match(invalid(sales, { marca: 'odonteck' }), /Dato no reconocido: marca/);
});

test('cifras de la marca de punta a punta: ventas, atención, recorridos, secuencias, difusiones, WhatsApp y preparar marca', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-mcp-cifras-'));
  const code = randomUUID();
  const server = await startServer({ dir, env: { ADMIN_INVITE_CODE: code, AI_PROVIDER: '', CHANNEL_CONNECTOR: '' } });
  let db = null;
  t.after(async () => {
    try {
      db?.close();
    } catch {}
    await server.stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const origin = server.origin;
  const admin = await registerAdmin(origin, code);
  db = openDb(dir);
  const api = (path, options = {}) => call(origin, path, { cookie: admin, ...options });
  const keyFor = async (brandId, scopes) =>
    (
      await api('/api/integrations/keys', {
        body: { brandId, name: 'Claude ' + scopes.join(' '), scopes },
        expected: 201,
      })
    ).token;
  let rid = 0;
  const tool = async (token, name, args = {}) => {
    const r = await fetch(origin + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rid, method: 'tools/call', params: { name, arguments: args } }),
    });
    const out = (await r.json()).result;
    return out.isError ? { error: out.content[0].text } : JSON.parse(out.content[0].text);
  };
  const outputs = [];
  const seen = async (...a) => {
    const r = await tool(...a);
    outputs.push(r);
    return r;
  };

  // ---- siembra: cinco clientes de GlobalVet escriben (cuatro por WhatsApp, uno por Instagram) con datos personales
  const PRIVATE = ['Ana Pérez Privada', '5512345678', 'ana.privada@example.com', 'REF-PRIV-'];
  const customers = [];
  for (let i = 0; i < 5; i++) {
    const who = await call(origin, '/api/auth/register', {
      body: { username: 'cliente' + i, name: PRIVATE[0] + ' ' + i, password: PASSWORD },
    });
    const conv = (
      await call(origin, '/api/conversations', {
        cookie: who.cookie,
        body: { courseId: 'aves', channel: i === 4 ? 'instagram' : 'whatsapp' },
      })
    ).conversation.id;
    await call(origin, '/api/conversations/' + conv + '/messages', {
      cookie: who.cookie,
      body: {
        text: `Hola, soy ${PRIVATE[0]}, mi teléfono es ${PRIVATE[1]} y mi correo ${PRIVATE[2]}`,
        clientRef: randomUUID(),
      },
      expected: 201,
    });
    await until(
      () => db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation'").get(conv),
      'respuesta del asistente',
    );
    customers.push(conv);
  }
  const H = 3_600_000,
    now = Date.now();
  const edition = db.prepare("SELECT * FROM editions WHERE course_id='aves' AND status='published'").get();
  assert.ok(edition, 'la apertura de demostración');
  // El primer mensaje de cada cliente fue hace 3 horas; los pedidos, hace 2 horas y media.
  const firstAt = now - 3 * H;
  const plan = [
    { method: 'card', cents: 55_000, paidAfter: 60 },
    { method: 'card', cents: 55_000, paidAfter: 90 },
    { method: 'card', cents: 55_000, paidAfter: 120 },
    { method: 'transfer', cents: 40_000, paidAfter: 150 },
    { method: null, cents: 55_000, paidAfter: null }, // pendiente, vigente
  ];
  customers.forEach((conv, i) => {
    db.prepare('UPDATE messages SET created_at=? WHERE conversation_id=?').run(firstAt + i, conv);
    const opp = db
      .prepare(
        'SELECT o.id,o.contact_id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id WHERE co.conversation_id=?',
      )
      .get(conv);
    db.prepare('UPDATE opportunities SET stage=?,lost_reason=? WHERE id=?').run(
      i < 3 ? 'ganada' : i === 3 ? 'perdida' : 'nuevo',
      i === 3 ? 'Precio' : '',
      opp.id,
    );
    const p = plan[i];
    const paidAt = p.paidAfter === null ? null : firstAt + p.paidAfter * 60_000;
    const orderId = randomUUID();
    db.prepare(
      'INSERT INTO orders(id,reference,brand_id,contact_id,opportunity_id,conversation_id,course_id,edition_id,amount_cents,currency,status,method,source,expires_at,paid_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      orderId,
      PRIVATE[3] + i,
      'globalvet',
      opp.contact_id,
      opp.id,
      conv,
      'aves',
      edition.id,
      p.cents,
      'MXN',
      paidAt ? 'paid' : 'pending',
      p.method,
      'agent',
      now + 48 * H,
      paidAt,
      now - 2.5 * H,
      now,
    );
    if (paidAt)
      db.prepare(
        "INSERT INTO ledger_entries(id,kind,brand_id,order_id,contact_id,course_id,edition_id,amount_cents,currency,method,occurred_at,period_day,note,dedupe_key,created_at) VALUES(?,'sale','globalvet',?,?,'aves',?,?,'MXN',?,?,?,'',?,?)",
      ).run(
        randomUUID(),
        orderId,
        opp.contact_id,
        edition.id,
        p.cents,
        p.method,
        paidAt,
        '2026-01-01',
        'sale:' + orderId,
        now,
      );
    if (i === 3)
      db.prepare(
        "INSERT INTO ledger_entries(id,kind,brand_id,order_id,contact_id,course_id,edition_id,amount_cents,currency,method,occurred_at,period_day,note,dedupe_key,created_at) VALUES(?,'refund','globalvet',?,?,'aves',?,?,'MXN',?,?,?,'Motivo privado',?,?)",
      ).run(
        randomUUID(),
        orderId,
        opp.contact_id,
        edition.id,
        -10_000,
        p.method,
        paidAt + 60_000,
        '2026-01-01',
        'refund:' + orderId,
        now,
      );
  });
  // Una venta de otra marca que no debe aparecer.
  const theirCourse = db.prepare("SELECT id FROM courses WHERE brand_id='odonteck'").get().id;
  db.prepare(
    "INSERT INTO ledger_entries(id,kind,brand_id,course_id,amount_cents,currency,method,occurred_at,period_day,note,dedupe_key,created_at) VALUES(?,'sale','odonteck',?,?,'MXN','card',?,?,'',?,?)",
  ).run(randomUUID(), theirCourse, 99_900, now - H, '2026-01-01', 'sale:otra', now);

  const insights = await keyFor('globalvet', [INSIGHTS_SCOPE]);
  const reader = await keyFor('globalvet', ['editions', 'orders']);
  const theirs = await keyFor('odonteck', [INSIGHTS_SCOPE]);

  // ---- permiso propio
  for (const t2 of INSIGHT_TOOLS)
    assert.match((await tool(reader, t2.name)).error, /no tiene el permiso «Claude: ver cifras/);
  for (const name of ['buscar_contactos', 'listar_conversaciones', 'listar_pedidos'])
    assert.match((await tool(insights, name)).error, /no tiene el permiso/, name + ': sin datos personales');

  // ---- ventas (todo cae en el periodo por omisión: los últimos 30 días)
  const sales = await seen(insights, 'cifras_ventas');
  assert.equal(sales.periodo.dias, 30);
  assert.equal(sales.periodo.zonaHoraria, 'America/Mexico_City');
  assert.ok(sales.definiciones.venta && sales.definiciones.conversion);
  assert.deepEqual(sales.totales, [
    { moneda: 'MXN', ventas: 4, reembolsos: 1, importe: 2050, reembolsado: 100, neto: 1950, ticketPromedio: 512.5 },
  ]);
  const card = sales.porMetodo.find(m => m.metodo === 'card');
  assert.deepEqual(
    { ventas: card.ventas, importe: card.importe, neto: card.neto },
    { ventas: 3, importe: 1650, neto: 1650 },
    'tres ventas con tarjeta: se muestran',
  );
  const transfer = sales.porMetodo.find(m => m.metodo === 'transfer');
  assert.deepEqual(
    { ventas: transfer.ventas, importe: transfer.importe, oculto: transfer.importesOcultos },
    { ventas: FEW, importe: null, oculto: true },
    'una sola venta por transferencia: «menos de 3» y sin importe',
  );
  const aves = sales.porCurso.find(k => k.cursoId === 'aves');
  assert.equal(aves.ventas, 4);
  assert.equal(aves.reembolsos, FEW);
  assert.equal(aves.importe, null, 'un solo reembolso en el curso: importes ocultos');
  assert.equal(sales.porCurso.length, 1, 'sólo la marca de la llave');
  assert.deepEqual(sales.pedidos, { creados: 5, pagados: 4, conversion: 80, porEstado: { paid: 4, pending: FEW } });
  assert.deepEqual(sales.pendientesAhora, [{ moneda: 'MXN', pedidos: 1, importe: 550 }]);
  const waits = [60, 90, 120, 150].map((m, i) => m * 60_000 - i); // pago menos primer mensaje (cada uno desfasado 1 ms)
  const sorted = [...waits].sort((a, b) => a - b);
  assert.equal(sales.tiempoDelPrimerMensajeAlPago.pedidosMedidos, 4);
  assert.equal(sales.tiempoDelPrimerMensajeAlPago.medianaHoras, Math.round((sorted[1] / H) * 10) / 10);
  assert.equal(
    sales.tiempoDelPrimerMensajeAlPago.promedioHoras,
    Math.round((waits.reduce((a, b) => a + b, 0) / 4 / H) * 10) / 10,
  );
  assert.equal(
    sales.serie.reduce((n, r) => n + r.ventas, 0),
    4,
    'la serie de tiempo no se oculta',
  );
  // otra marca: sólo lo suyo
  const other = await seen(theirs, 'cifras_ventas');
  assert.deepEqual(
    other.totales.map(x => [x.ventas, x.importe]),
    [[1, 999]],
  );
  assert.equal(other.pedidos.creados, 0);
  // agrupar por mes
  const monthly = await seen(insights, 'cifras_ventas', { agrupar: 'mes' });
  assert.ok(monthly.serie.every(r => /^\d{4}-\d{2}$/.test(r.periodo)));
  // un periodo que no incluye las ventas
  const empty = await seen(insights, 'cifras_ventas', { desde: '2025-01-01', hasta: '2025-01-31' });
  assert.deepEqual(empty.totales, []);
  assert.equal(empty.pedidos.creados, 0);

  // ---- validación del periodo
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City' }).format(new Date());
  const future = new Date(Date.parse(today) + 3 * 86_400_000).toISOString().slice(0, 10);
  for (const [args, re] of [
    [{ desde: '2026-13-01' }, /fecha AAAA-MM-DD válida/],
    [{ desde: '2026-02-30', hasta: '2026-03-01' }, /fecha AAAA-MM-DD válida/],
    [{ desde: '2026-03-02', hasta: '2026-03-01' }, /posterior a «desde»/],
    [{ hasta: future }, /futura/],
    [{ desde: '2024-01-01', hasta: '2025-06-01' }, /hasta 366 días/],
    [{ desde: '2019-12-31', hasta: '2020-01-02' }, /anterior a 2020/],
    [{ desde: 20260101 }, /debe ser texto/],
  ])
    assert.match((await tool(insights, 'cifras_ventas', args)).error, re, JSON.stringify(args));
  assert.match((await tool(insights, 'cifras_atencion', { hasta: future })).error, /futura/);
  assert.match((await tool(insights, 'resultados_difusiones', { desde: 'ayer' })).error, /válida/);

  // ---- atención y embudo
  const att = await seen(insights, 'cifras_atencion');
  assert.equal(att.conversaciones.abiertas, 5);
  assert.deepEqual(
    att.conversaciones.porCanal.map(c => [c.canal, c.abiertas]),
    [
      ['instagram', FEW],
      ['whatsapp', 4],
    ],
  );
  assert.deepEqual(
    { ...att.embudo },
    { creadas: 5, interesado: 3, inscripcion: 3, ganadas: 3, perdidas: FEW, abiertas: FEW, conversion: 60 },
  );
  // un motivo escrito por una sola oportunidad no sale tal cual: va con «otros motivos» (antes salía «Precio»)
  assert.deepEqual(att.motivosDePerdida, [{ motivo: OTHER_REASONS, cantidad: FEW }]);
  const stage = s => att.ahora.oportunidadesPorEtapa.find(x => x.etapa === s).cantidad;
  assert.deepEqual([stage('ganada'), stage('perdida'), stage('nuevo'), stage('interesado')], [3, FEW, FEW, 0]);
  assert.equal(
    att.ahora.esperandoPersona,
    db.prepare("SELECT count(*) n FROM conversations WHERE brand_id='globalvet' AND status='waiting'").get().n,
  );
  assert.ok(att.definiciones.embudo && att.periodo.zonaHoraria);

  // ---- recorridos: el mismo cálculo que la pestaña «Rendimiento»
  const flow = (
    await api('/api/chatflows', {
      body: { brandId: 'globalvet', name: 'Ventas (prueba)', clientRef: 'cifras-' + randomUUID() },
      expected: 201,
    })
  ).flow;
  const flows = await seen(insights, 'rendimiento_recorridos');
  assert.ok(flows.recorridos.some(f => f.recorridoId === flow.id && f.conversaciones === 0));
  const perf = await seen(insights, 'rendimiento_recorridos', { recorridoId: flow.id });
  assert.equal(perf.conversaciones.empezaron, 0);
  assert.ok(perf.definiciones.llegaron);
  assert.match(
    (await tool(theirs, 'rendimiento_recorridos', { recorridoId: flow.id })).error,
    /no existe en esta marca/,
  );
  assert.match(
    (await tool(insights, 'rendimiento_recorridos', { recorridoId: '../x' })).error,
    /no existe en esta marca/,
  );

  // ---- secuencias y difusiones
  const seq = (
    await api('/api/sequences', {
      body: {
        brandId: 'globalvet',
        title: 'Seguimiento (prueba)',
        steps: [
          { timing: { base: 'enrolled', amount: 1, unit: 'days' }, send: { kind: 'text', text: '¿Pudiste verlo?' } },
        ],
        settings: {},
        clientRef: 'cifras-' + randomUUID(),
      },
      expected: 201,
    })
  ).sequence;
  const seqs = await seen(insights, 'resultados_secuencias');
  const mine = seqs.secuencias.find(s => s.secuenciaId === seq.id);
  assert.equal(mine.inscritas, 0);
  assert.equal(mine.pasos.length, 1);
  assert.match((await tool(theirs, 'resultados_secuencias', { secuenciaId: seq.id })).error, /no existe en esta marca/);
  assert.ok(!(await tool(theirs, 'resultados_secuencias')).secuencias.some(s => s.secuenciaId === seq.id));
  const bc = await seen(insights, 'resultados_difusiones');
  assert.deepEqual(bc.difusiones, []);

  // ---- WhatsApp y preparar marca
  const wa = await seen(insights, 'salud_whatsapp');
  assert.ok(Array.isArray(wa.numeros));
  assert.equal(typeof wa.plantillas.total, 'number');
  assert.ok(/^\d{4}-\d{2}$/.test(wa.periodo.mes));
  assert.match((await tool(insights, 'salud_whatsapp', { mes: '2026-1' })).error, /AAAA-MM/);
  const ready = await seen(insights, 'que_le_falta_a_la_marca');
  const screen = (await api('/api/readiness')).brands.find(b => b.id === 'globalvet');
  assert.deepEqual(
    ready.pasos.map(s => [s.paso, s.listo]),
    screen.steps.map(s => [s.id, s.done]),
    'la misma lista que la pantalla, con los pasos de los módulos',
  );
  assert.ok(ready.pasos.some(s => s.paso === 'real-mode') && ready.pasos.some(s => s.paso === 'course-access'));

  // ---- resumen de la semana: las 5 conversaciones y 3 ganadas sembradas caen en los últimos 7 días
  const week = await seen(insights, 'resumen_semana');
  assert.equal(week.marca.id, 'globalvet');
  assert.equal(week.estaSemana.conversacionesNuevas, 5, 'las 5 conversaciones de esta semana');
  assert.equal(week.estaSemana.pidieronInscribirse, 3, 'las 3 ganadas llegaron a inscripción');
  assert.equal(week.estaSemana.inscripcionesDePractica, 3);
  assert.equal(week.semanaPasada.conversacionesNuevas, 0, 'nada la semana anterior');
  assert.ok('respuestaMedianaMinutos' in week.estaSemana);

  // ---- resultados de la evaluación: sin corridas, y con una corrida que incluye un caso fallido
  const noEval = await seen(insights, 'resultados_evaluacion');
  assert.equal(noEval.hayEvaluacion, false);
  db.prepare(
    'INSERT INTO eval_runs(id,brand_id,mode,provider,total,passed,score,results,duration_ms,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
  ).run(
    'run-1',
    'globalvet',
    'autonomous',
    'claude',
    2,
    1,
    50,
    JSON.stringify([
      {
        caseId: 'c1',
        title: 'Precio',
        input: '¿Cuánto cuesta?',
        expected: { intent: 'price' },
        got: { intent: 'price', action: 'responde', sources: ['catalogue'] },
        pass: true,
        failures: [],
      },
      {
        caseId: 'c2',
        title: 'Duración',
        input: '¿Cuánto dura?',
        expected: { intent: 'duration', source: 'catalogue' },
        got: { intent: 'duration', action: 'responde', sources: ['knowledge', 'catalogue'] },
        pass: false,
        failures: ['fuente: esperaba «catalogue», obtuvo «knowledge, catalogue»'],
      },
    ]),
    1500,
    null,
    Date.now(),
  );
  const ev = await seen(insights, 'resultados_evaluacion');
  assert.equal(ev.puntaje, 50);
  assert.equal(ev.pasaron, 1);
  assert.equal(ev.total, 2);
  assert.equal(ev.nivel, 'autonomous');
  assert.equal(ev.proveedor, 'claude');
  assert.equal(ev.alcanzaUmbral, false, '50 % no alcanza el 85 %');
  assert.equal(ev.fallaron, 1);
  assert.equal(ev.fallos[0].caso, 'Duración');
  assert.deepEqual(ev.fallos[0].obtenido.fuentes, ['knowledge', 'catalogue']);
  assert.match(ev.fallos[0].motivos[0], /fuente: esperaba/);

  // ---- ninguna salida trae datos personales ni referencias de pedidos
  const everything = JSON.stringify(outputs);
  for (const p of PRIVATE) assert.ok(!everything.includes(p), 'no sale: ' + p);
  assert.doesNotMatch(everything, /Motivo privado/);

  // ---- quien creó la llave deja de administrar la marca: la llave ya no ve cifras
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(adminId, 'globalvet'); // sigue en el equipo
  db.prepare("UPDATE users SET role='agent' WHERE id=?").run(adminId);
  assert.match((await tool(insights, 'cifras_ventas')).error, /ya no administra la marca/);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(adminId);
});
