// Conector de Claude: preparar configuración del CRM en BORRADOR (docs/PLAN_MCP_CLAUDE.md, «Preparar configuración
// en borrador»): aperturas, promociones, textos de contenido, plantillas de WhatsApp, difusiones, segmentos y reglas.
// Mismas rutas que las pantallas; nada se publica, aprueba, envía a Meta, programa, envía ni enciende; nada cruza
// marcas y ninguna salida trae datos de clientes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TOOLS, invalid } from '../server/mcp.mjs';
import { CONFIG_ROUTES, CONFIG_SCOPE, CONFIG_TOOLS } from '../server/lib/mcp-config.mjs';
import { DRAFT_SCOPE } from '../server/lib/mcp-drafts.mjs';
import { createRouteCaller } from '../server/lib/mcp-call.mjs';
import { startServer } from './helpers/server.mjs';
import { PASSWORD, call, openDb, registerAdmin, until } from './helpers/crm.mjs';

const allowed = createRouteCaller({ routes: CONFIG_ROUTES }).allowed;
const FORBIDDEN =
  /^(status|estado|enabled|encendid[oa]|activ[oa]|publicad[oa]|published|publicar|activar|aprobad[oa]|approved|aprobar|enviar|programar|scheduledAt|programad[oa])$/i;
function keysOf(schema, out = []) {
  for (const [k, s] of Object.entries(schema?.properties || {})) {
    out.push(k);
    keysOf(s, out);
    if (s.items) keysOf(s.items, out);
  }
  return out;
}
const ref = () => 'mcp-cfg-' + randomUUID();

test('configuración en borrador: permisos, esquemas sin estado y lista cerrada de rutas', () => {
  for (const t of CONFIG_TOOLS) {
    assert.ok([CONFIG_SCOPE, DRAFT_SCOPE].includes(t.scope), t.name);
    assert.equal(t.inputSchema.additionalProperties, false, t.name);
    assert.doesNotMatch(
      t.name,
      /publicar|aprobar|activar|encender|programar|enviar|archivar|borrar|pausar|sincronizar/,
    );
    assert.deepEqual(
      keysOf(t.inputSchema).filter(k => FORBIDDEN.test(k)),
      [],
      t.name + ' no tiene datos de estado',
    );
    assert.ok(TOOLS.includes(t));
  }
  // reglas: el mismo permiso de pantalla que los recorridos (automation.manage) → permiso de borradores de automatización
  assert.deepEqual(
    CONFIG_TOOLS.filter(t => t.scope === DRAFT_SCOPE)
      .map(t => t.name)
      .sort(),
    ['actualizar_regla', 'crear_regla', 'listar_reglas', 'listas_de_reglas', 'probar_regla'],
  );
  for (const [name, method, path] of [
    ['catalogue', 'POST', '/api/catalogue/editions'],
    ['catalogue', 'PATCH', '/api/catalogue/editions/e-1'],
    ['catalogue', 'PATCH', '/api/catalogue/templates/t-1'],
    ['catalogue', 'POST', '/api/catalogue/preview'],
    ['wa-templates', 'POST', '/api/whatsapp/templates'],
    ['wa-templates', 'POST', '/api/whatsapp/templates/validate'],
    ['broadcasts', 'POST', '/api/broadcasts/b-12345678/preview'],
    ['audiences', 'POST', '/api/audiences/preview'],
    ['rules', 'POST', '/api/rules/test'],
  ])
    assert.ok(allowed(name, method, path), method + ' ' + path);
  const uuid = randomUUID();
  for (const [name, method, path] of [
    ['catalogue', 'POST', '/api/catalogue/editions/e-1/approve'],
    ['catalogue', 'POST', '/api/catalogue/editions/e-1/archive'],
    ['catalogue', 'POST', '/api/catalogue/templates/t-1/approve'],
    ['catalogue', 'POST', '/api/catalogue/flyers'],
    ['catalogue', 'POST', '/api/catalogue/flyers/f-1/approve'],
    ['catalogue', 'POST', '/api/catalogue/courses'],
    ['catalogue', 'PATCH', '/api/catalogue/courses/aves'],
    ['catalogue', 'POST', '/api/catalogue/files'],
    ['catalogue', 'PATCH', '/api/catalogue/editions/e-1/../archive'],
    ['wa-templates', 'POST', `/api/whatsapp/templates/${uuid}/submit`],
    ['wa-templates', 'POST', `/api/whatsapp/templates/${uuid}/duplicate`],
    ['wa-templates', 'POST', `/api/whatsapp/templates/${uuid}/restore`],
    ['wa-templates', 'DELETE', `/api/whatsapp/templates/${uuid}`],
    ['wa-templates', 'POST', '/api/whatsapp/templates/sync'],
    ['wa-templates', 'POST', '/api/whatsapp/templates/adopt'],
    ['wa-templates', 'GET', '/api/whatsapp/templates/remote'],
    ['wa-templates', 'POST', '/api/wa-templates/files'],
    ['broadcasts', 'POST', '/api/broadcasts/b-12345678/schedule'],
    ['broadcasts', 'POST', '/api/broadcasts/b-12345678/unschedule'],
    ['broadcasts', 'POST', '/api/broadcasts/b-12345678/pause'],
    ['broadcasts', 'POST', '/api/broadcasts/b-12345678/resume'],
    ['broadcasts', 'POST', '/api/broadcasts/b-12345678/cancel'],
    ['broadcasts', 'GET', '/api/broadcasts/b-12345678/recipients'],
    ['broadcasts', 'PATCH', '/api/broadcasts/settings/globalvet'],
    ['audiences', 'PATCH', `/api/audiences/${uuid}`],
    ['audiences', 'GET', `/api/audiences/${uuid}/members`],
    ['audiences', 'POST', `/api/audiences/${uuid}/members`],
    ['audiences', 'GET', `/api/audiences/${uuid}/export`],
    ['audiences', 'POST', `/api/audiences/${uuid}/archive`],
    ['rules', 'POST', '/api/rules/r-1/activate'],
    ['rules', 'POST', '/api/rules/r-1/pause'],
    ['rules', 'POST', '/api/rules/r-1/archive'],
    ['rules', 'PUT', '/api/rules/order'],
    ['rules', 'PATCH', '/api/rules/settings/globalvet'],
    ['rules', 'GET', '/api/rules/r-1/runs'],
    ['sequences', 'POST', '/api/sequences/s-1/enable'],
  ])
    assert.equal(allowed(name, method, path), false, method + ' ' + path);
  assert.ok(CONFIG_ROUTES.every(([, method]) => ['GET', 'POST', 'PATCH'].includes(method)));
  // el esquema se hace cumplir: datos de estado o de más se rechazan antes de tocar nada
  const schema = name => CONFIG_TOOLS.find(t => t.name === name).inputSchema;
  const ed = { cursoId: 'aves', nombre: 'Marzo', modalidad: 'online', precio: 900, clientRef: ref() };
  assert.equal(invalid(schema('crear_apertura_borrador'), ed), null);
  for (const extra of [{ estado: 'published' }, { status: 'published' }, { publicar: true }])
    assert.match(invalid(schema('crear_apertura_borrador'), { ...ed, ...extra }), /Dato no reconocido/);
  assert.match(
    invalid(schema('actualizar_plantilla_whatsapp'), { plantillaId: 'x', revision: 1, approved: true }),
    /Dato no reconocido: approved/,
  );
  assert.match(
    invalid(schema('crear_difusion_borrador'), { plantillaId: 'x', clientRef: ref(), scheduledAt: 1 }),
    /Dato no reconocido: scheduledAt/,
  );
  assert.match(
    invalid(schema('crear_difusion_borrador'), {
      plantillaId: 'x',
      clientRef: ref(),
      tandas: { tamano: 10, pausaMinutos: 5 },
    }),
    /fuera del rango/,
  );
  assert.match(
    invalid(schema('crear_regla'), { titulo: 'x', definicion: {}, clientRef: ref(), enabled: true }),
    /enabled/,
  );
  assert.match(
    invalid(schema('crear_segmento'), { nombre: 'x', definicion: {}, clientRef: ref(), role: 'suppression' }),
    /role/,
  );
  assert.match(
    invalid(schema('crear_plantilla_whatsapp'), {
      nombre: 'x',
      cuerpo: 'y',
      clientRef: ref(),
      encabezado: { type: 'text', status: 'approved' },
    }),
    /encabezado\.status/,
  );
});

test('preparar el CRM en borrador de punta a punta, sin publicar, aprobar, enviar ni programar nada', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-mcp-config-'));
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
    assert.equal(r.error, undefined, a[1] + ': ' + r.error);
    return r;
  };
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  const auditOf = action => count('SELECT count(*) n FROM audit WHERE action=?', action);

  // una persona real escribe antes: sus datos no deben salir por estas herramientas
  const PRIVATE = ['Ana Pérez Privada', '5512345678'];
  const ana = await call(origin, '/api/auth/register', {
    body: { username: 'ana', name: PRIVATE[0], password: PASSWORD },
  });
  const conv = (
    await call(origin, '/api/conversations', { cookie: ana.cookie, body: { courseId: 'aves', channel: 'whatsapp' } })
  ).conversation.id;
  await call(origin, '/api/conversations/' + conv + '/messages', {
    cookie: ana.cookie,
    body: { text: 'Hola, mi teléfono es ' + PRIVATE[1], clientRef: randomUUID() },
    expected: 201,
  });
  await until(
    () => db.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND sender_kind='automation'").get(conv),
    'respuesta del asistente',
  );
  const sideEffects = () => ({
    messages: count('SELECT count(*) n FROM messages'),
    orders: count('SELECT count(*) n FROM orders'),
    recipients: count('SELECT count(*) n FROM campaign_recipients'),
    published: count("SELECT count(*) n FROM editions WHERE status='published'"),
    livePromotions: count("SELECT count(*) n FROM promotions WHERE status!='draft'"),
    approvedTexts: count("SELECT count(*) n FROM content_templates WHERE status='approved'"),
    submitted: count('SELECT count(*) n FROM wa_templates WHERE submitted_at IS NOT NULL'),
    scheduled: count("SELECT count(*) n FROM campaigns WHERE status!='draft'"),
    liveRules: count("SELECT count(*) n FROM automation_rules WHERE status!='draft'"),
  });
  const before = sideEffects();

  const config = await keyFor('globalvet', [CONFIG_SCOPE]);
  const drafts = await keyFor('globalvet', [DRAFT_SCOPE]);
  const reader = await keyFor('globalvet', ['editions']);
  const theirs = await keyFor('odonteck', [CONFIG_SCOPE, DRAFT_SCOPE]);
  const theirCourse = db.prepare("SELECT id FROM courses WHERE brand_id='odonteck'").get().id;
  const theirEdition = db.prepare("SELECT id FROM editions WHERE brand_id='odonteck'").get().id;

  // ---- permisos
  assert.match(
    (await tool(reader, 'crear_apertura_borrador', {})).error,
    /no tiene el permiso «Claude: preparar en BORRADOR/,
  );
  assert.match((await tool(config, 'crear_regla', {})).error, /no tiene el permiso «Claude: armar recorridos, reglas/);
  assert.match((await tool(drafts, 'crear_difusion_borrador', {})).error, /no tiene el permiso/);
  const sum = await tool(config, 'resumen');
  assert.match(sum.puedeModificar, /nunca publica, aprueba, envía a Meta, programa ni envía/);

  // ================= 1) catálogo: apertura y promoción en borrador
  const edRef = ref();
  const ed = await seen(config, 'crear_apertura_borrador', {
    cursoId: 'aves',
    nombre: 'Marzo 2027 (Claude)',
    inicio: '2027-03-01 19:00',
    fin: '2027-03-01 21:00',
    zona: 'America/Mexico_City',
    docente: 'Docente de prueba',
    modalidad: 'online',
    precio: 1200,
    cupo: 30,
    cupoDisponible: 30,
    clientRef: edRef,
  });
  assert.equal(ed.estado, 'draft');
  assert.equal(ed.duplicado, false);
  const edRow = db.prepare('SELECT * FROM editions WHERE id=?').get(ed.aperturaId);
  assert.deepEqual(
    { status: edRow.status, brand: edRow.brand_id, price: edRow.price_cents, starts: edRow.starts_at },
    { status: 'draft', brand: 'globalvet', price: 120_000, starts: Date.UTC(2027, 2, 2, 1, 0) },
    'borrador, en la marca, con la hora local correcta',
  );
  assert.equal(
    count("SELECT count(*) n FROM catalogue_events WHERE entity_id=? AND action='created'", ed.aperturaId),
    1,
    'la misma ruta del catálogo',
  );
  const again = await seen(config, 'crear_apertura_borrador', {
    cursoId: 'aves',
    nombre: 'Otra',
    modalidad: 'online',
    precio: 1,
    clientRef: edRef,
  });
  assert.equal(again.duplicado, true);
  assert.equal(again.aperturaId, ed.aperturaId);
  const up = await seen(config, 'actualizar_apertura_borrador', {
    aperturaId: ed.aperturaId,
    revision: ed.revision,
    precio: 1100,
  });
  assert.equal(up.estado, 'draft');
  assert.equal(up.precio, 1100);
  assert.match(
    (
      await tool(config, 'actualizar_apertura_borrador', {
        aperturaId: ed.aperturaId,
        revision: ed.revision,
        precio: 1,
      })
    ).error,
    /cambió/,
  );
  const published = db.prepare("SELECT * FROM editions WHERE course_id='aves' AND status='published'").get();
  assert.match(
    (
      await tool(config, 'actualizar_apertura_borrador', {
        aperturaId: published.id,
        revision: published.revision,
        precio: 1,
      })
    ).error,
    /no está en borrador/,
  );
  assert.match(
    (
      await tool(config, 'crear_apertura_borrador', {
        cursoId: theirCourse,
        nombre: 'x',
        modalidad: 'online',
        precio: 1,
        clientRef: ref(),
      })
    ).error,
    /no existe en esta marca/,
  );
  const promo = await seen(config, 'crear_promocion_borrador', {
    aperturaId: ed.aperturaId,
    nombre: 'Preventa',
    precio: 900,
    inicio: '2027-01-01',
    fin: '2027-02-01',
    clientRef: ref(),
  });
  assert.equal(promo.estado, 'draft');
  assert.equal(db.prepare('SELECT status FROM promotions WHERE id=?').get(promo.promocionId).status, 'draft');
  const promoUp = await seen(config, 'actualizar_promocion_borrador', {
    promocionId: promo.promocionId,
    revision: promo.revision,
    precio: 950,
  });
  assert.equal(promoUp.precio, 950);
  assert.equal(promoUp.estado, 'draft');
  assert.match(
    (
      await tool(config, 'crear_promocion_borrador', {
        aperturaId: theirEdition,
        nombre: 'x',
        precio: 1,
        inicio: '2027-01-01',
        fin: '2027-01-02',
        clientRef: ref(),
      })
    ).error,
    /no existe en esta marca/,
  );

  // ================= textos de contenido
  const txt = await seen(config, 'crear_texto_borrador', {
    titulo: 'Información del curso (Claude)',
    escenario: 'info',
    texto: 'Hola, {{nombre}}. {{curso}} empieza el {{fecha}}.',
    cursoId: 'aves',
    clientRef: ref(),
  });
  assert.equal(txt.estado, 'draft');
  const preview = await seen(config, 'probar_texto', { aperturaId: published.id, textoId: txt.textoId });
  assert.match(preview.comoSeVeria, /Hola, Cliente de prueba/);
  assert.match(
    (await tool(config, 'probar_texto', { aperturaId: published.id, texto: 'Hola {{inventado}}' })).error,
    /inventado|variable|dato/i,
  );
  const txtUp = await seen(config, 'actualizar_texto_borrador', {
    textoId: txt.textoId,
    revision: txt.revision,
    titulo: 'Info v2',
  });
  assert.equal(txtUp.titulo, 'Info v2');
  // una persona lo aprueba: desde aquí ya no se toca (guardarlo lo devolvería a borrador)
  await api('/api/catalogue/templates/' + txt.textoId + '/approve', { body: { expectedRevision: txtUp.revision } });
  assert.match(
    (
      await tool(config, 'actualizar_texto_borrador', {
        textoId: txt.textoId,
        revision: txtUp.revision + 1,
        titulo: 'No',
      })
    ).error,
    /no está en borrador/,
  );
  assert.equal(db.prepare('SELECT status FROM content_templates WHERE id=?').get(txt.textoId).status, 'approved');
  const cat = await seen(config, 'listar_borradores_catalogo');
  assert.ok(cat.aperturasEnBorrador.some(e => e.aperturaId === ed.aperturaId));
  assert.ok(!cat.aperturasEnBorrador.some(e => e.aperturaId === theirEdition));

  // ================= 2) plantillas de WhatsApp: borrador del CRM, nunca a Meta
  const tpl = await seen(config, 'crear_plantilla_whatsapp', {
    nombre: 'aviso_inscripcion_claude',
    categoria: 'utility',
    encabezado: { type: 'text', text: 'Tu inscripción' },
    cuerpo: 'Hola {{nombre}}, tu lugar en {{curso}} está apartado. Te esperamos.',
    pie: 'TEC Capital',
    botones: [{ type: 'quick_reply', text: 'Gracias' }],
    muestras: { nombre: 'Luisa', curso: 'Aves' },
    clientRef: ref(),
  });
  assert.equal(tpl.estado, 'draft');
  assert.ok(Array.isArray(tpl.loQueFaltaParaEnviarAMeta));
  const tplRow = db.prepare('SELECT * FROM wa_templates WHERE id=?').get(tpl.plantillaId);
  assert.deepEqual(
    { status: tplRow.status, submitted: tplRow.submitted_at, brand: tplRow.brand_id },
    { status: 'draft', submitted: null, brand: 'globalvet' },
  );
  const tplSeen = await seen(config, 'ver_plantilla_whatsapp', { plantillaId: tpl.plantillaId });
  assert.match(tplSeen.contenido.cuerpo, /tu lugar en/);
  const tplUp = await seen(config, 'actualizar_plantilla_whatsapp', {
    plantillaId: tpl.plantillaId,
    revision: tplSeen.revision,
    pie: 'TEC Capital · aviso',
  });
  assert.equal(tplUp.estado, 'draft');
  const check = await seen(config, 'revisar_plantilla_whatsapp', {
    cuerpo: 'Hola {{nombre}}, gracias por escribir. Te esperamos.',
  });
  assert.ok(check.vistaPrevia);
  assert.match((await tool(config, 'revisar_plantilla_whatsapp', { cuerpo: 'corto' })).error, /al menos 10/);
  const tplList = await seen(config, 'listar_plantillas_whatsapp');
  assert.ok(tplList.plantillas.some(x => x.plantillaId === tpl.plantillaId && x.editable));
  // Meta la aprueba (simulado): ya no se edita desde aquí
  db.prepare("UPDATE wa_templates SET status='approved',approved_at=? WHERE id=?").run(Date.now(), tpl.plantillaId);
  assert.match(
    (
      await tool(config, 'actualizar_plantilla_whatsapp', {
        plantillaId: tpl.plantillaId,
        revision: tplUp.revision,
        pie: 'x',
      })
    ).error,
    /ya se envió a Meta/,
  );
  assert.match(
    (await tool(theirs, 'ver_plantilla_whatsapp', { plantillaId: tpl.plantillaId })).error,
    /no existe en esta marca/,
  );

  // ================= 4) audiencias y difusiones: sólo cifras, nunca a quién
  const fields = await seen(config, 'campos_de_segmento');
  assert.ok(!fields.campos.some(f => ['name', 'phone'].includes(f.name)), 'sin campos de datos personales');
  const def = {
    version: 1,
    match: 'all',
    groups: [{ match: 'all', rules: [{ field: 'has_phone', op: 'is', value: false }] }],
  };
  const counted = await seen(config, 'contar_segmento', { definicion: def });
  assert.ok(['menos de 3', 0].includes(counted.cumplen) || counted.cumplen >= 3);
  for (const rule of [
    { field: 'name', op: 'contains', value: 'Ana' },
    { field: 'phone', op: 'contains', value: '5512' },
    { field: 'email', op: 'contains', value: 'ana' },
  ])
    assert.match(
      (
        await tool(config, 'contar_segmento', {
          definicion: { version: 1, match: 'all', groups: [{ match: 'all', rules: [rule] }] },
        })
      ).error,
      /no filtra por nombre, teléfono, correo/,
    );
  const seg = await seen(config, 'crear_segmento', {
    nombre: 'Sin teléfono (Claude)',
    definicion: def,
    clientRef: ref(),
  });
  assert.equal(db.prepare('SELECT kind,brand_id FROM audiences WHERE id=?').get(seg.audienciaId).kind, 'segment');
  const auds = await seen(config, 'listar_audiencias');
  assert.ok(auds.audiencias.some(x => x.audienciaId === seg.audienciaId));
  const opts = await seen(config, 'opciones_difusion');
  assert.ok(opts.plantillas.some(x => x.plantillaId === tpl.plantillaId));
  const bRef = ref();
  const bc = await seen(config, 'crear_difusion_borrador', {
    titulo: 'Aviso de inscripción (Claude)',
    plantillaId: tpl.plantillaId,
    todos: true,
    excluir: [seg.audienciaId],
    cursoId: 'aves',
    ensayo: true,
    clientRef: bRef,
  });
  assert.equal(bc.estado, 'draft');
  const bcRow = db.prepare('SELECT * FROM campaigns WHERE id=?').get(bc.difusionId);
  assert.deepEqual(
    { status: bcRow.status, brand: bcRow.brand_id, consent: bcRow.require_consent },
    { status: 'draft', brand: 'globalvet', consent: 1 },
  );
  assert.equal(JSON.parse(bcRow.options).sendHours, 'brand');
  const est = await seen(config, 'estimar_difusion', { difusionId: bc.difusionId });
  assert.ok('laRecibirian' in est && 'noLaRecibirian' in est && 'loQueImpediriaProgramarla' in est);
  assert.equal(est.sample, undefined);
  const bcUp = await seen(config, 'actualizar_difusion_borrador', {
    difusionId: bc.difusionId,
    revision: bc.revision,
    ritmoPorMinuto: 30,
  });
  assert.equal(bcUp.estado, 'draft');
  assert.equal(bcUp.opciones.ratePerMinute, 30);
  assert.match(
    (
      await tool(config, 'crear_difusion_borrador', {
        plantillaId: tpl.plantillaId,
        audienciaId: randomUUID(),
        clientRef: ref(),
      })
    ).error,
    /no existe en esta marca/,
  );
  assert.match(
    (await tool(theirs, 'estimar_difusion', { difusionId: bc.difusionId })).error,
    /no existe en esta marca/,
  );
  assert.match(
    (await tool(theirs, 'crear_difusion_borrador', { plantillaId: tpl.plantillaId, todos: true, clientRef: ref() }))
      .error,
    /no existe en esta marca/,
  );
  // una persona la cancela (fuera del borrador): desde aquí ya no se toca
  db.prepare("UPDATE campaigns SET status='cancelled',revision=revision+1 WHERE id=?").run(bc.difusionId);
  assert.match(
    (
      await tool(config, 'actualizar_difusion_borrador', {
        difusionId: bc.difusionId,
        revision: bcUp.revision + 1,
        titulo: 'x',
      })
    ).error,
    /ya no está en borrador/,
  );

  // ================= 5) reglas por mensaje (permiso de borradores de automatización)
  const ruleDef = {
    trigger: { type: 'keyword', mode: 'contains', words: ['horario'] },
    actions: [{ type: 'send_text', text: 'Nuestro horario es de 9 a 18 h.' }],
  };
  const rule = await seen(drafts, 'crear_regla', { titulo: 'Horario (Claude)', definicion: ruleDef, clientRef: ref() });
  assert.equal(rule.estado, 'draft');
  const tried = await seen(drafts, 'probar_regla', { texto: '¿cuál es su horario?', reglaId: rule.reglaId });
  assert.match(JSON.stringify(tried.resultado), /horario/);
  const ruleUp = await seen(drafts, 'actualizar_regla', {
    reglaId: rule.reglaId,
    revision: rule.revision,
    titulo: 'Horario v2',
  });
  assert.equal(ruleUp.estado, 'draft');
  assert.ok((await seen(drafts, 'listar_reglas')).reglas.some(r => r.reglaId === rule.reglaId));
  await api('/api/rules/' + rule.reglaId + '/activate', { body: { expectedRevision: ruleUp.revision } });
  assert.match(
    (await tool(drafts, 'actualizar_regla', { reglaId: rule.reglaId, revision: ruleUp.revision + 1, titulo: 'No' }))
      .error,
    /no está en borrador/,
  );
  assert.match(
    (await tool(theirs, 'actualizar_regla', { reglaId: rule.reglaId, revision: 1, titulo: 'x' })).error,
    /no existe en esta marca/,
  );
  assert.match(
    (await tool(theirs, 'probar_regla', { texto: 'hola', reglaId: rule.reglaId })).error,
    /no existe en esta marca/,
  );

  // ---- bitácora del conector
  for (const action of [
    'mcp.edition.draft',
    'mcp.promotion.draft',
    'mcp.content.draft',
    'mcp.wa_template.draft',
    'mcp.broadcast.draft',
    'mcp.segment.create',
    'mcp.rule.draft',
  ])
    assert.ok(auditOf(action) >= 1, action);

  // ---- nada se publicó, aprobó, envió a Meta, programó, envió ni encendió desde el conector
  const after = sideEffects();
  const byPerson = {
    approvedTexts: 1, // lo aprobó una persona
    scheduled: 1, // la canceló una persona
    liveRules: 1, // la encendió una persona
  };
  assert.deepEqual(after, {
    ...before,
    ...Object.fromEntries(Object.entries(byPerson).map(([k, v]) => [k, before[k] + v])),
  });

  // ---- ninguna salida trae datos de clientes
  const everything = JSON.stringify(outputs);
  for (const p of PRIVATE) assert.ok(!everything.includes(p), 'no sale: ' + p);
});
