// Plantillas completas de WhatsApp (D-3, docs/PLAN_PLANTILLAS_COMPLETAS.md): definición canónica y validaciones, lo
// que viaja a Meta, avisos de estado, calidad y categoría, adopción por lote de cientos de plantillas por páginas y por
// cuenta, envío desde el chat con encabezado y botón, respuesta de botón, permisos, alcance por marca y baja suave.
// Todo contra el Meta de mentira (test/helpers/fake-meta.mjs): nada sale a internet y los datos son inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PASSWORD, call, until, whatsappLab } from './helpers/crm.mjs';
import { APP_ID, NUMBER, PNG, WABA_ID, WABA_ID_2, metaHook, metaInbound, metaText } from './helpers/fake-meta.mjs';
import { assertSchemaCurrent } from './helpers/schema.mjs';
import {
  fromEditor,
  fromMeta,
  preview,
  submitProblems,
  toMetaArgs,
} from '../server/modules/wa-templates/definition.mjs';
import { requireAccountWide } from '../server/modules/wa-templates/module.mjs';

const PDF = Buffer.from('%PDF-1.4\n% prueba\n');
const b64 = buffer => buffer.toString('base64');
const BODY = 'Hola {{nombre}}, ya abrimos inscripciones a {{curso}}. Responde a este mensaje para apartar tu lugar.';

test('definición canónica: del editor a la forma de Meta y de vuelta, con las validaciones de §6.4', () => {
  const files = id => (id === 'f1' ? { id: 'f1', filename: 'flyer.png', mime: 'image/png', size: 2048 } : null);
  const { definition, warnings } = fromEditor(
    {
      category: 'marketing',
      header: { type: 'image', fileId: 'f1' },
      body: BODY,
      footer: 'Responde BAJA para dejar de recibir mensajes.',
      buttons: [
        { type: 'quick_reply', text: 'Sí, me interesa' },
        { type: 'quick_reply', text: 'Baja' },
        { type: 'url', text: 'Ver el curso', url: 'https://ejemplo.mx/cursos/{{fijo.ruta}}' },
      ],
      samples: { 'fijo.ruta': 'aves' },
    },
    { files },
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(definition.header, { type: 'image', fileId: 'f1', filename: 'flyer.png', mime: 'image/png' });
  assert.equal(
    definition.body.text,
    'Hola {{1}}, ya abrimos inscripciones a {{2}}. Responde a este mensaje para apartar tu lugar.',
  );
  assert.deepEqual(
    definition.body.vars.map(v => v.key),
    ['nombre', 'curso'],
  );
  assert.deepEqual(definition.buttons[2], {
    type: 'url',
    text: 'Ver el curso',
    url: 'https://ejemplo.mx/cursos/{{1}}',
    var: { key: 'fijo.ruta', sample: 'aves', fallback: null },
  });
  assert.deepEqual(submitProblems(definition), []);
  const args = toMetaArgs(definition, { handle: 'h1' });
  assert.deepEqual(args.header, { format: 'IMAGE', handle: 'h1' });
  assert.deepEqual(args.examples, ['María', 'Plan sanitario para aves']);
  assert.equal(args.buttons[2].example, 'aves');
  assert.equal(preview(definition).body.startsWith('Hola María, ya abrimos'), true);

  // validaciones (cada una con su mensaje)
  const bad = (over, pattern) =>
    assert.throws(
      () => fromEditor({ body: BODY, ...over }, { files }),
      e => e.status === 400 && pattern.test(e.message),
    );
  bad({ header: { type: 'text', text: 'x'.repeat(61) } }, /60 caracteres/);
  bad({ header: { type: 'text', text: 'Hola {{nombre}} de {{curso}}' } }, /un solo dato/);
  bad({ header: { type: 'image', fileId: 'nada' } }, /biblioteca de la marca/);
  bad({ footer: 'Pie con {{nombre}}' }, /no admite datos/);
  bad({ buttons: Array.from({ length: 11 }, (_, i) => ({ type: 'quick_reply', text: 'Opción ' + i })) }, /hasta 10/);
  bad({ buttons: [{ type: 'quick_reply', text: 'x'.repeat(26) }] }, /25 caracteres/);
  bad({ buttons: [{ type: 'url', text: 'Ver', url: 'http://ejemplo.mx' }] }, /https/);
  bad({ buttons: [{ type: 'url', text: 'Ver', url: 'https://ejemplo.mx/{{fijo.a}}/x' }] }, /al final/);
  bad({ buttons: [{ type: 'phone', text: 'Llamar', phone: '55 12' }] }, /internacional/);
  bad(
    {
      buttons: [
        { type: 'quick_reply', text: 'Sí' },
        { type: 'quick_reply', text: 'sí' },
      ],
    },
    /dos botones/,
  );
  bad(
    {
      buttons: [
        { type: 'quick_reply', text: 'Sí' },
        { type: 'url', text: 'Ver', url: 'https://ejemplo.mx' },
        { type: 'quick_reply', text: 'No' },
      ],
    },
    /sin intercalar/,
  );
  bad({ body: 'Hola {{telefono}}, tenemos una novedad para ti hoy.' }, /no es un dato disponible/);
  bad({ body: 'Hola {{1}}, tenemos una novedad para ti hoy.' }, /por su nombre/);
  bad({ body: 'Hola\t{{nombre}}, tenemos una novedad para ti hoy.' }, /tabuladores/);
  // avisos: utilidad con lenguaje promocional; más de tres botones
  const w = fromEditor({
    category: 'utility',
    body: 'Hola {{nombre}}, hoy tienes un descuento especial en tu inscripción.',
    buttons: ['A', 'B', 'C', 'D'].map(text => ({ type: 'quick_reply', text })),
  }).warnings.map(x => x.code);
  assert.deepEqual(w, ['many_buttons', 'promo_in_utility']);
  // una muestra que falta impide mandarla a revisión
  assert.match(
    submitProblems(fromEditor({ body: 'Hola {{nombre}}, tu vigencia es {{fijo.vigencia}}. Gracias.' }).definition)[0],
    /muestra de \{\{fijo\.vigencia\}\}/,
  );

  // de Meta a canónica: encabezado de texto con dato, botones de enlace con dato, copiar código
  const remote = fromMeta([
    { type: 'HEADER', format: 'TEXT', text: 'Hola {{1}}', example: { header_text: ['Ana'] } },
    { type: 'BODY', text: 'Tu curso {{1}} empieza el {{2}}.', example: { body_text: [['Aves', 'lunes']] } },
    { type: 'FOOTER', text: 'Pie' },
    {
      type: 'BUTTONS',
      buttons: [
        { type: 'URL', text: 'Ver', url: 'https://ejemplo.mx/{{1}}', example: ['x'] },
        { type: 'COPY_CODE', example: 'CUPON10' },
      ],
    },
  ]);
  assert.equal(remote.header.vars[0].sample, 'Ana');
  assert.deepEqual(
    remote.body.vars.map(v => [v.key, v.sample]),
    [
      [null, 'Aves'],
      [null, 'lunes'],
    ],
  );
  assert.equal(remote.buttons[0].var.sample, 'x');
  assert.equal(remote.buttons[1].code.sample, 'CUPON10');
});

test('lo que toca la cuenta entera (sincronizar, ver y adoptar lo de Meta) pide el permiso en todas las marcas', () => {
  const denied = Object.assign(new Error('sin permiso'), { status: 403 });
  // Acceso simulado: la persona administra plantillas sólo en las marcas de `mine`.
  const access = mine => ({
    require(user, perm, brandId) {
      assert.equal(perm, 'templates.manage');
      if (brandId === undefined ? !mine.length : !mine.includes(brandId)) throw denied;
    },
  });
  const brands = ['uno', 'dos', 'tres'];
  assert.doesNotThrow(() => requireAccountWide(access(brands), {}, 'templates.manage', brands));
  assert.throws(() => requireAccountWide(access(['uno']), {}, 'templates.manage', brands), denied);
  assert.throws(() => requireAccountWide(access([]), {}, 'templates.manage', brands), denied);
  // Sin marcas todavía, basta con tener el permiso.
  assert.doesNotThrow(() => requireAccountWide(access(['uno']), {}, 'templates.manage', []));
});

test('plantillas completas de punta a punta con el Meta de mentira', async t => {
  const lab = await whatsappLab(t, { META_WABA_ID: WABA_ID, META_APP_ID: APP_ID });
  const { meta, db } = lab;
  const origin = () => lab.origin();
  const admin = lab.admin;
  const api = (path, options = {}) => call(origin(), path, { cookie: admin, ...options });
  assertSchemaCurrent(db);

  // personas: un asesor de GlobalVet, otro de OdonTeck y una clienta
  const register = async (username, name) =>
    (await call(origin(), '/api/auth/register', { body: { username, name, password: PASSWORD } })).cookie;
  const agentGv = await register('asesor-gv', 'Asesor GlobalVet');
  const agentOt = await register('asesor-ot', 'Asesor OdonTeck');
  const customer = await register('clienta', 'Clienta curiosa');
  for (const [username, brand] of [
    ['asesor-gv', 'globalvet'],
    ['asesor-ot', 'odonteck'],
  ]) {
    const id = db.prepare('SELECT id FROM users WHERE username=?').get(username).id;
    db.prepare("UPDATE users SET role='agent' WHERE id=?").run(id);
    db.prepare('INSERT INTO brand_members(user_id,brand_id) VALUES(?,?)').run(id, brand);
  }

  // 1) permisos: administrar plantillas pide templates.manage (hoy sólo administración)
  await call(origin(), '/api/whatsapp/templates', { cookie: agentGv, expected: 403 });
  await call(origin(), '/api/whatsapp/templates', { cookie: customer, expected: 403 });
  const upload = (cookie, file, expected = 201, brandId = 'globalvet') =>
    call(origin(), '/api/wa-templates/files', {
      cookie,
      body: { brandId, file, clientRef: randomUUID() },
      expected,
    });
  await upload(agentGv, { name: 'flyer.png', type: 'image/png', base64: b64(PNG) }, 403);

  // 2) archivo de muestra: un archivo falso (extensión que no coincide con el contenido) se rechaza
  assert.equal(
    (await upload(admin, { name: 'flyer.png', type: 'image/png', base64: b64(PDF) }, 400)).code,
    'upload_type_mismatch',
  );
  assert.equal(
    (await upload(admin, { name: 'texto.png', type: 'image/png', base64: b64(Buffer.from('hola')) }, 400)).code,
    'upload_type_not_allowed',
  );
  const ref = randomUUID();
  const file = (
    await call(origin(), '/api/wa-templates/files', {
      cookie: admin,
      body: {
        brandId: 'globalvet',
        file: { name: '../flyer aves.png', type: 'image/png', base64: b64(PNG) },
        clientRef: ref,
      },
      expected: 201,
    })
  ).file;
  assert.equal(file.filename, 'flyer aves.png');
  assert.equal(file.mime, 'image/png');
  // repetir la subida con la misma referencia no guarda otro archivo
  const again = await call(origin(), '/api/wa-templates/files', {
    cookie: admin,
    body: { brandId: 'globalvet', file: { name: 'flyer.png', type: 'image/png', base64: b64(PNG) }, clientRef: ref },
    expected: 201,
  });
  assert.equal(again.file.id, file.id);
  assert.match(
    db.prepare('SELECT storage_name FROM library_files WHERE id=?').get(file.id).storage_name,
    /^globalvet\/[a-f0-9-]+\.png$/,
  );
  // entrega con sesión y alcance por marca
  const got = await fetch(origin() + '/api/wa-templates/files/' + file.id, { headers: { Cookie: agentGv } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), PNG);
  assert.equal(
    (await fetch(origin() + '/api/wa-templates/files/' + file.id, { headers: { Cookie: agentOt } })).status,
    404,
  );
  assert.equal((await fetch(origin() + '/api/wa-templates/files/' + file.id)).status, 401);

  // 3) validar y crear una plantilla con imagen, cuerpo con datos, pie y botones
  const editor = {
    brandId: 'globalvet',
    name: 'apertura_aves',
    language: 'es_MX',
    category: 'marketing',
    header: { type: 'image', fileId: file.id },
    body: BODY,
    footer: 'Responde BAJA para dejar de recibir mensajes.',
    buttons: [
      { type: 'quick_reply', text: 'Sí, me interesa' },
      { type: 'url', text: 'Ver el curso', url: 'https://ejemplo.mx/cursos/aves' },
    ],
  };
  const checked = await api('/api/whatsapp/templates/validate', { body: editor });
  assert.deepEqual(checked.problems, []);
  assert.equal(checked.preview.header.type, 'image');
  assert.deepEqual(
    checked.preview.buttons.map(b => b.text),
    ['Sí, me interesa', 'Ver el curso'],
  );
  await api('/api/whatsapp/templates', {
    body: { ...editor, buttons: [{ type: 'url', text: 'Ver', url: 'http://x.mx' }] },
    expected: 400,
  });
  const draftRef = randomUUID();
  const draft = (await api('/api/whatsapp/templates', { body: { ...editor, clientRef: draftRef }, expected: 201 }))
    .template;
  assert.equal(draft.status, 'draft');
  assert.equal(draft.editable, true);
  assert.equal(draft.components.header.fileId, file.id);
  // un reintento con la misma referencia devuelve la misma plantilla
  assert.equal(
    (await api('/api/whatsapp/templates', { body: { ...editor, clientRef: draftRef } })).template.id,
    draft.id,
  );
  // otra con encabezado de texto con un dato, para corregirla después de un rechazo
  const second = (
    await api('/api/whatsapp/templates', {
      body: {
        brandId: 'globalvet',
        name: 'recordatorio_clase',
        category: 'utility',
        header: { type: 'text', text: 'Hola {{nombre}}' },
        body: 'Tu clase de {{curso}} empieza pronto. Responde a este mensaje si tienes dudas.',
      },
      expected: 201,
    })
  ).template;

  // 4) enviar a revisión: la muestra se sube por sesión y viaja todo el JSON de Meta
  const pending = (await api('/api/whatsapp/templates/' + draft.id + '/submit', { body: {} })).template;
  assert.equal(pending.status, 'pending');
  assert.ok(pending.metaId);
  assert.deepEqual(
    meta.uploads.filter(u => u.kind !== 'media').map(u => u.kind),
    ['session', 'sample'],
  );
  assert.equal(meta.uploads[0].length, PNG.length);
  assert.equal(meta.uploads[0].type, 'image/png');
  assert.deepEqual(meta.created[0], {
    name: 'apertura_aves',
    language: 'es_MX',
    category: 'MARKETING',
    components: [
      { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['4::handle-2'] } },
      {
        type: 'BODY',
        text: draft.body,
        example: { body_text: [['María', 'Plan sanitario para aves']] },
      },
      { type: 'FOOTER', text: 'Responde BAJA para dejar de recibir mensajes.' },
      {
        type: 'BUTTONS',
        buttons: [
          { type: 'QUICK_REPLY', text: 'Sí, me interesa' },
          { type: 'URL', text: 'Ver el curso', url: 'https://ejemplo.mx/cursos/aves' },
        ],
      },
    ],
  });
  await api('/api/whatsapp/templates/' + draft.id + '/submit', { body: {}, expected: 409 });
  // el contenido de una plantilla en revisión no se cambia
  await api('/api/whatsapp/templates/' + draft.id, {
    method: 'PATCH',
    body: { body: BODY + ' Gracias.', expectedRevision: pending.revision },
    expected: 409,
  });
  const second1 = (await api('/api/whatsapp/templates/' + second.id + '/submit', { body: {} })).template;
  assert.deepEqual(meta.created[1].components[0], {
    type: 'HEADER',
    format: 'TEXT',
    text: 'Hola {{1}}',
    example: { header_text: ['María'] },
  });

  // 5) avisos de Meta: aprobación, rechazo, calidad, categoría y pausa (template.update)
  const notice = (field, value) =>
    metaHook(origin(), value, {
      field,
      entryId: WABA_ID,
      time: Math.floor(Date.now() / 1000) + Math.floor(Math.random() * 1e6),
    });
  const row = id => db.prepare('SELECT * FROM wa_templates WHERE id=?').get(id);
  await notice('message_template_status_update', {
    event: 'APPROVED',
    message_template_id: Number(pending.metaId),
    message_template_name: 'apertura_aves',
    message_template_language: 'es_MX',
    reason: 'NONE',
  });
  await until(() => row(draft.id).status === 'approved', 'la aprobación llega por aviso');
  assert.ok(row(draft.id).approved_at);
  assert.ok(db.prepare("SELECT 1 FROM domain_events WHERE type='plantilla.estado' AND entity_id=?").get(draft.id));
  await notice('message_template_status_update', {
    event: 'REJECTED',
    message_template_id: Number(second1.metaId),
    message_template_name: 'recordatorio_clase',
    message_template_language: 'es_MX',
    reason: 'INVALID_FORMAT',
  });
  await until(() => row(second.id).status === 'rejected', 'el rechazo llega por aviso');
  const rejected = (await api('/api/whatsapp/templates/' + second.id)).template;
  assert.equal(rejected.rejectReason, 'INVALID_FORMAT');
  assert.match(rejected.rejectText, /formato no es válido/);
  // una rechazada se corrige en el CRM y vuelve a Meta como corrección, no como alta
  const fixed = (
    await api('/api/whatsapp/templates/' + second.id, {
      method: 'PATCH',
      body: {
        body: 'Tu clase de {{curso}} empieza pronto. Responde a este mensaje si tienes alguna duda.',
        expectedRevision: rejected.revision,
      },
    })
  ).template;
  assert.equal(
    (await api('/api/whatsapp/templates/' + second.id + '/submit', { body: {} })).template.status,
    'pending',
  );
  assert.equal(meta.edited.length, 1);
  assert.equal(meta.edited[0].id, second1.metaId);
  assert.match(JSON.stringify(meta.edited[0].body.components), /alguna duda/);
  assert.equal(meta.created.length, 2);
  assert.ok(fixed.revision > rejected.revision);
  await notice('message_template_quality_update', {
    previous_quality_score: 'GREEN',
    new_quality_score: 'RED',
    message_template_id: Number(pending.metaId),
    message_template_name: 'apertura_aves',
    message_template_language: 'es_MX',
  });
  await until(() => row(draft.id).quality === 'red', 'la calidad llega por aviso');
  await notice('template_category_update', {
    message_template_id: Number(second1.metaId),
    message_template_name: 'recordatorio_clase',
    message_template_language: 'es_MX',
    previous_category: 'UTILITY',
    new_category: 'MARKETING',
  });
  await until(() => row(second.id).category === 'marketing', 'el cambio de categoría llega por aviso');
  assert.equal(row(second.id).prev_category, 'utility');
  assert.ok(row(second.id).category_changed_at);
  assert.ok((await api('/api/whatsapp/templates/' + second.id + '/ack', { body: {} })).template.categoryAckAt);
  await notice('message_template_status_update', {
    event: 'PAUSED',
    message_template_id: Number(second1.metaId),
    message_template_name: 'recordatorio_clase',
    message_template_language: 'es_MX',
    reason: 'NONE',
  });
  await until(() => row(second.id).status === 'paused', 'la pausa llega por aviso');

  // 6) desde el chat: la plantilla con imagen y botones sale con su encabezado y la carga del botón
  await metaText(origin(), '5215512340001', 'wamid.tpl-in-1', 'Hola, quiero informes', { name: 'María Pérez' });
  const conv = await until(
    () => db.prepare("SELECT * FROM conversations WHERE wa_peer='5215512340001'").get(),
    'la conversación nace',
  );
  const list = (await call(origin(), '/api/conversations/' + conv.id + '/wa-templates', { cookie: agentGv })).templates;
  assert.deepEqual(
    list.map(x => [x.name, x.header, x.buttons]),
    [['apertura_aves', 'image', ['Sí, me interesa', 'Ver el curso']]],
  );
  assert.match(list[0].text, /^Hola María, ya abrimos inscripciones a Plan sanitario para aves\./);
  await call(origin(), '/api/conversations/' + conv.id + '/wa-templates', { cookie: agentOt, expected: 404 });
  const sendRef = randomUUID();
  const sentMsg = await call(origin(), '/api/conversations/' + conv.id + '/wa-templates', {
    cookie: agentGv,
    body: { templateId: draft.id, clientRef: sendRef },
    expected: 201,
  });
  const out = await until(
    () => meta.sent.find(m => m.type === 'template' && m.template.name === 'apertura_aves'),
    'la plantilla sale a Meta',
  );
  const media = meta.uploads.find(u => u.kind === 'media');
  assert.equal(media.bytes > PNG.length, true);
  assert.deepEqual(out.template.components[0], {
    type: 'header',
    parameters: [{ type: 'image', image: { id: 'media-' + (meta.uploads.indexOf(media) + 1) } }],
  });
  assert.deepEqual(out.template.components[1], {
    type: 'body',
    parameters: [
      { type: 'text', text: 'María' },
      { type: 'text', text: 'Plan sanitario para aves' },
    ],
  });
  assert.equal(out.template.components[2].sub_type, 'quick_reply');
  assert.match(out.template.components[2].parameters[0].payload, /^tpl:[a-f0-9]{8}:0$/);
  const saved = db.prepare('SELECT * FROM messages WHERE id=?').get(sentMsg.id);
  assert.deepEqual(JSON.parse(saved.wa_template).header, { type: 'image', fileId: file.id });
  assert.deepEqual(JSON.parse(saved.buttons), ['Sí, me interesa']);
  // el reintento con la misma referencia no duplica
  assert.equal(
    (
      await call(origin(), '/api/conversations/' + conv.id + '/wa-templates', {
        cookie: agentGv,
        body: { templateId: draft.id, clientRef: sendRef },
      })
    ).duplicate,
    true,
  );
  // la persona pulsa el botón: llega como pulsación (interaction) con la carga
  const wamid = await until(
    () => db.prepare('SELECT provider_ref FROM messages WHERE id=?').get(sentMsg.id).provider_ref,
    'la referencia de Meta',
  );
  await metaInbound(
    origin(),
    '5215512340001',
    'wamid.tpl-in-2',
    { type: 'button', button: { text: 'Sí, me interesa', payload: out.template.components[2].parameters[0].payload } },
    { replyTo: wamid, name: 'María Pérez' },
  );
  const tap = await until(
    () =>
      db
        .prepare("SELECT * FROM messages WHERE conversation_id=? AND sender_kind='customer' AND reply IS NOT NULL")
        .get(conv.id),
    'la pulsación queda en el chat',
  );
  assert.equal(JSON.parse(tap.reply).kind, 'template_button');
  assert.equal(JSON.parse(tap.reply).payload, out.template.components[2].parameters[0].payload);
  assert.equal(tap.reply_to_id, sentMsg.id);

  // 7) adopción por lote: 250 plantillas remotas, por páginas, sin tope fijo e idempotente
  const remote = meta.templates(WABA_ID);
  for (const x of remote) x.status = 'APPROVED'; // Meta ya aprobó las dos del CRM
  for (let i = 1; i <= 250; i++) {
    const name = 'promo_' + String(i).padStart(3, '0');
    const components =
      i <= 3
        ? [
            { type: 'HEADER', format: 'IMAGE' },
            { type: 'BODY', text: 'Hola {{1}}, mira esto.', example: { body_text: [['Ana']] } },
          ]
        : i === 4
          ? [{ type: 'BODY', text: 'Tu código es {{1}}.' }]
          : [
              {
                type: 'BODY',
                text: 'Hola {{1}}, tenemos novedades de {{2}}.',
                example: { body_text: [['Ana', 'Aves']] },
              },
            ];
    remote.push({
      id: String(500000 + i),
      name,
      language: 'es_MX',
      status: 'APPROVED',
      category: i === 4 ? 'AUTHENTICATION' : 'MARKETING',
      components,
    });
  }
  meta.listCalls.length = 0;
  const synced = await api('/api/whatsapp/templates/sync', { body: {} });
  assert.equal(synced.found, 252);
  assert.equal(synced.updated, 2);
  assert.equal(synced.remote, 250);
  assert.deepEqual(
    meta.listCalls.map(c => c.after),
    [0, 100, 200],
  );
  let adopted = 0;
  const skipped = [];
  for (let offset = 0; ;) {
    const page = await api('/api/whatsapp/templates/remote?limit=100&offset=' + offset);
    if (!page.remote.length) break;
    const r = await api('/api/whatsapp/templates/adopt', {
      body: { brandId: 'globalvet', items: page.remote.map(x => ({ name: x.name, language: x.language })) },
      expected: 201,
    });
    adopted += r.templates.length;
    skipped.push(...r.skipped);
    // lo adoptado sale de la lista remota; lo que no se pudo, queda y se avanza
    offset += r.skipped.length;
    if (page.next === null && !r.templates.length) break;
  }
  assert.equal(adopted, 249);
  assert.deepEqual(
    skipped.map(s => [s.name, /autenticación/.test(s.reason)]),
    [['promo_004', true]],
  );
  const withImage = db.prepare("SELECT * FROM wa_templates WHERE name='promo_001'").get();
  assert.equal(JSON.parse(withImage.components).header.type, 'image');
  assert.equal(withImage.waba_id, WABA_ID);
  assert.equal(withImage.status, 'approved');
  // adoptar otra vez lo mismo no duplica: devuelve las que ya están
  const repeat = await api('/api/whatsapp/templates/adopt', {
    body: { brandId: 'globalvet', items: [{ name: 'promo_010', language: 'es_MX' }] },
    expected: 201,
  });
  assert.deepEqual(repeat.templates, []);
  assert.deepEqual(
    repeat.existing.map(x => x.name),
    ['promo_010'],
  );
  assert.equal(db.prepare("SELECT count(*) n FROM wa_templates WHERE name LIKE 'promo_%'").get().n, 249);
  // una adoptada sin indicar sus datos no se ofrece en el chat hasta completarla
  const promo10 = repeat.existing[0];
  assert.equal(promo10.needsMapping, true);
  const chat = () => call(origin(), '/api/conversations/' + conv.id + '/wa-templates', { cookie: agentGv });
  assert.equal(
    (await chat()).templates.some(x => x.name === 'promo_010'),
    false,
  );
  await api('/api/whatsapp/templates/' + promo10.id, {
    method: 'PATCH',
    body: { variables: ['nombre', 'curso'], expectedRevision: promo10.revision },
  });
  assert.equal(
    (await chat()).templates.some(x => x.name === 'promo_010'),
    true,
  );
  // la lista paginada de la pantalla
  const pageList = await api('/api/whatsapp/templates?brand=globalvet&q=promo_0&limit=50');
  assert.equal(pageList.templates.length, 50);
  assert.equal(pageList.total, 98);
  assert.equal(pageList.next, '50');
  assert.ok(pageList.limits.count >= 251);

  // 8) baja suave, restaurar, duplicar y borrar en Meta
  const tmpDraft = (
    await api('/api/whatsapp/templates', {
      body: {
        brandId: 'globalvet',
        name: 'borrador_suelto',
        body: 'Hola {{nombre}}, esto es sólo un borrador de prueba.',
      },
      expected: 201,
    })
  ).template;
  assert.equal((await api('/api/whatsapp/templates/' + tmpDraft.id, { method: 'DELETE' })).result, 'deleted');
  assert.equal(row(tmpDraft.id), undefined);
  assert.equal((await api('/api/whatsapp/templates/' + draft.id, { method: 'DELETE' })).result, 'archived');
  assert.equal(
    (await chat()).templates.some(x => x.name === 'apertura_aves'),
    false,
  );
  const archived = (await api('/api/whatsapp/templates/' + draft.id)).template;
  assert.ok(archived.archivedAt);
  const restored = (
    await api('/api/whatsapp/templates/' + draft.id + '/restore', { body: { expectedRevision: archived.revision } })
  ).template;
  assert.equal(restored.archivedAt, null);
  const copyRef = randomUUID();
  const copied = (
    await api('/api/whatsapp/templates/' + draft.id + '/duplicate', {
      body: { name: 'apertura_aves_v2', brandId: 'odonteck', clientRef: copyRef },
      expected: 201,
    })
  ).template;
  assert.equal(copied.status, 'draft');
  assert.equal(copied.brandId, 'odonteck');
  assert.equal(copied.copiedFrom, draft.id);
  assert.equal(copied.components.header.fileId, null, 'el archivo de muestra es de la biblioteca de su marca');
  assert.equal(
    (
      await api('/api/whatsapp/templates/' + draft.id + '/duplicate', {
        body: { name: 'apertura_aves_v2', brandId: 'odonteck', clientRef: copyRef },
      })
    ).template.id,
    copied.id,
  );
  assert.equal((await api('/api/whatsapp/templates/' + draft.id + '?meta=1', { method: 'DELETE' })).result, 'archived');
  assert.deepEqual(meta.deleted.at(-1), { waba: WABA_ID, name: 'apertura_aves', hsmId: pending.metaId });
  assert.equal(row(draft.id).status, 'deleted');
  await api('/api/whatsapp/templates/' + draft.id + '/restore', {
    body: { expectedRevision: row(draft.id).revision },
    expected: 409,
  });

  // 9) otra cuenta (el número real después del de prueba): el mismo nombre no choca
  meta.templates(WABA_ID_2).push({
    id: '700001',
    name: 'promo_010',
    language: 'es_MX',
    status: 'APPROVED',
    category: 'MARKETING',
    components: [{ type: 'BODY', text: 'Hola {{1}}, tenemos novedades de {{2}}.' }],
  });
  await lab.state.server.stop();
  await lab.start({ META_WABA_ID: WABA_ID_2 });
  const admin2 = admin; // la sesión vive en la base: sigue valiendo tras el reinicio
  const s2 = await call(origin(), '/api/whatsapp/templates/sync', { cookie: admin2, body: {} });
  assert.equal(s2.found, 1);
  assert.equal(s2.remote, 1);
  const r2 = await call(origin(), '/api/whatsapp/templates/adopt', {
    cookie: admin2,
    body: { brandId: 'odonteck', items: [{ name: 'promo_010', language: 'es_MX', variables: ['nombre', 'marca'] }] },
    expected: 201,
  });
  assert.equal(r2.templates.length, 1);
  assert.deepEqual(
    db
      .prepare("SELECT waba_id,brand_id FROM wa_templates WHERE name='promo_010' ORDER BY waba_id")
      .all()
      .map(x => [x.waba_id, x.brand_id]),
    [
      [WABA_ID, 'globalvet'],
      [WABA_ID_2, 'odonteck'],
    ],
  );
  assert.equal(lab.state.server.logs().includes('EAAprueba'), false);
  void NUMBER;
});
