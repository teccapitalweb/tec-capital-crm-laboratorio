// Contrato de canal 1.1 (docs/PLAN_CONTRATO_CANAL.md): lo que el lector de Meta añade, el lector tolerante de la
// bandeja, las columnas canónicas de `messages` y los oyentes de estado. Todo con datos inventados.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CONTRACT_VERSION,
  CONTRACT_VERSIONS,
  laneOf,
  metaChannel,
  readStoredEvent,
  withContract,
} from '../server/connectors.mjs';
import {
  NUMBER,
  WABA,
  metaBody,
  metaInbound,
  metaInboundValue,
  metaNotice,
  metaPricing,
  metaStatus,
  metaStatusValue,
  metaText,
} from './helpers/fake-meta.mjs';
import { until, whatsappLab } from './helpers/crm.mjs';

const meta = metaChannel({ env: {} });
const PHONE = '5215512345678';
const BSUID = 'MX.1349120865530274';
const parse = (value, options) => meta.parseWebhook(metaBody(value, options));

test('contrato 1.1: un entrante o un estado sin datos nuevos se traduce exactamente como en 1.0', () => {
  // sin cuenta (entry.id) ni identificador de usuario: las claves nuevas no aparecen
  const [inbound] = parse(metaInboundValue(PHONE, 'wamid.1', { type: 'text', text: { body: 'Hola' } }), {
    entryId: '',
  });
  assert.deepEqual(Object.keys(inbound.data).sort(), [
    'at',
    'channel',
    'from',
    'kind',
    'media',
    'name',
    'providerRef',
    'referral',
    'text',
    'to',
  ]);
  const [status] = parse(metaStatusValue('wamid.2', 'delivered', { recipient: '' }), { entryId: '' });
  assert.deepEqual(Object.keys(status.data).sort(), ['at', 'providerRef', 'reason', 'state']);
  assert.equal(CONTRACT_VERSION, '1.1');
  assert.deepEqual(CONTRACT_VERSIONS, ['1.0', '1.1']);
});

test('contrato 1.1: el entrante trae cuenta, identificador de usuario, mensaje citado, pulsaciones y reacciones', () => {
  const [withUser] = parse(
    metaInboundValue(PHONE, 'wamid.a', { type: 'text', text: { body: 'Hola' } }, { bsuid: BSUID, username: 'maria.l' }),
  );
  assert.deepEqual(withUser.data.peer, {
    ids: [
      { kind: 'wa_phone', value: PHONE },
      { kind: 'wa_bsuid', value: BSUID },
    ],
    name: 'Persona de prueba',
    username: 'maria.l',
  });
  assert.deepEqual(withUser.data.account, {
    provider: 'meta-whatsapp',
    externalId: NUMBER,
    scopeId: WABA,
    displayPhone: '15550100000',
  });
  // sin teléfono visible: sólo el identificador de usuario, y el carril usa su huella
  const [onlyUser] = parse(metaInboundValue('', 'wamid.b', { type: 'text', text: { body: 'Hola' } }, { bsuid: BSUID }));
  assert.equal(onlyUser.data.from, undefined);
  assert.deepEqual(onlyUser.data.peer.ids, [{ kind: 'wa_bsuid', value: BSUID }]);
  assert.match(laneOf('channel', 'meta', onlyUser), new RegExp('^in:meta:' + NUMBER + ':[0-9a-f]{16}$'));
  assert.equal(laneOf('channel', 'meta', onlyUser).includes(BSUID), false);

  const [button] = parse(
    metaInboundValue(
      PHONE,
      'wamid.c',
      { type: 'button', button: { text: 'Quiero inscribirme', payload: 'c:dest-1:0' } },
      { replyTo: 'wamid.plantilla', forwarded: true },
    ),
  );
  assert.equal(button.data.text, 'Quiero inscribirme', 'el texto de 1.0 se conserva');
  assert.deepEqual(button.data.interaction, {
    kind: 'template_button',
    id: null,
    title: 'Quiero inscribirme',
    payload: 'c:dest-1:0',
    description: null,
  });
  assert.deepEqual(button.data.replyTo, { providerRef: 'wamid.plantilla' });
  assert.equal(button.data.forwarded, true);

  const [list, reaction, voice, system, place] = parse({
    ...metaInboundValue(PHONE, 'x', { type: 'text', text: { body: '' } }),
    messages: [
      {
        from: PHONE,
        id: 'wamid.d',
        type: 'interactive',
        interactive: { type: 'list_reply', list_reply: { id: 'curso-aves', title: 'Aves', description: 'Martes' } },
      },
      { from: PHONE, id: 'wamid.e', type: 'reaction', reaction: { message_id: 'wamid.out1', emoji: '👍' } },
      { from: PHONE, id: 'wamid.f', type: 'audio', audio: { id: '77', mime_type: 'audio/ogg', voice: true } },
      { from: PHONE, id: 'wamid.g', type: 'system', system: { type: 'user_changed_number', wa_id: '5215599999999' } },
      { from: PHONE, id: 'wamid.h', type: 'location', location: { latitude: 19.4, longitude: -99.1, name: 'Sede' } },
    ],
  });
  assert.deepEqual(list.data.interaction, {
    kind: 'list',
    id: 'curso-aves',
    title: 'Aves',
    payload: null,
    description: 'Martes',
  });
  assert.deepEqual(reaction.data.reaction, { emoji: '👍', providerRef: 'wamid.out1' });
  assert.deepEqual(voice.data.media, { id: '77', mime: 'audio/ogg', filename: null, voice: true });
  assert.deepEqual(system.data.system, { kind: 'user_changed_number', newPhone: '5215599999999', newUserId: null });
  assert.deepEqual(place.data.location, { latitude: 19.4, longitude: -99.1, name: 'Sede', address: null });
});

test('contrato 1.1: el estado trae código y detalle del fallo, tarificación, dato de regreso, destinatario y cuenta', () => {
  const [failed] = parse(
    metaStatusValue('wamid.out9', 'failed', {
      recipientUserId: BSUID,
      callback: 'tc:dest-9:1',
      error: { code: 131049, title: 'Message not delivered', error_data: { details: 'Para cuidar la experiencia' } },
    }),
  );
  assert.equal(failed.data.code, 131049);
  assert.equal(failed.data.detail, 'Para cuidar la experiencia');
  assert.match(failed.data.reason, /cuidar la experiencia/, 'el motivo en palabras del equipo sigue igual');
  assert.equal(failed.data.callback, 'tc:dest-9:1');
  assert.deepEqual(failed.data.recipient, { phone: PHONE, userId: BSUID });
  assert.equal(failed.data.account.externalId, NUMBER);
  const [priced] = parse(metaStatusValue('wamid.out10', 'sent', { pricing: metaPricing('MARKETING') }));
  assert.deepEqual(priced.data.pricing, { billable: true, category: 'marketing', type: 'regular', model: 'PMP' });
});

test('contrato 1.1: avisos de plantillas, número, cuenta y preferencias, con un id estable por cambio', () => {
  const time = 1795000000;
  const status = parse(
    {
      event: 'APPROVED',
      message_template_id: 555,
      message_template_name: 'aviso_novedad',
      message_template_language: 'es_MX',
      reason: 'NONE',
    },
    { field: 'message_template_status_update', time },
  );
  assert.deepEqual(status, [
    {
      id: 'message_template_status_update:555:approved:' + time,
      type: 'template.update',
      data: {
        account: { provider: 'meta-whatsapp', externalId: null, scopeId: WABA, displayPhone: null },
        scopeId: WABA,
        templateId: '555',
        name: 'aviso_novedad',
        language: 'es_MX',
        field: 'status',
        value: 'approved',
        previous: null,
        reason: null,
      },
    },
  ]);
  const again = parse(
    {
      event: 'APPROVED',
      message_template_id: 555,
      message_template_name: 'aviso_novedad',
      message_template_language: 'es_MX',
    },
    { field: 'message_template_status_update', time },
  );
  assert.equal(again[0].id, status[0].id, 'el mismo aviso repetido por Meta tiene el mismo id');
  const [quality] = parse(
    { previous_quality_score: 'GREEN', new_quality_score: 'YELLOW', message_template_id: 555 },
    { field: 'message_template_quality_update', time },
  );
  assert.deepEqual([quality.data.field, quality.data.value, quality.data.previous], ['quality', 'yellow', 'green']);
  const [category] = parse(
    { previous_category: 'UTILITY', new_category: 'MARKETING', message_template_id: 555 },
    { field: 'template_category_update', time },
  );
  assert.deepEqual([category.data.field, category.data.value], ['category', 'marketing']);
  const [limit] = parse(
    { display_phone_number: '15550100000', event: 'UPGRADE', current_limit: 'TIER_10K', old_limit: 'TIER_2K' },
    { field: 'phone_number_quality_update', time },
  );
  assert.deepEqual(
    [limit.type, limit.data.field, limit.data.value, limit.data.previous],
    ['account.update', 'limit', 'tier_10k', 'tier_2k'],
  );
  const [flagged] = parse(
    { display_phone_number: '15550100000', event: 'FLAGGED' },
    { field: 'phone_number_quality_update', time },
  );
  assert.deepEqual([flagged.data.field, flagged.data.value], ['quality', 'flagged']);
  const [alert] = parse(
    { alert_type: 'OBA_APPROVED', alert_severity: 'INFORMATIONAL', alert_status: 'NONE' },
    { field: 'account_alerts', time },
  );
  assert.deepEqual([alert.data.field, alert.data.details.severity], ['alert', 'INFORMATIONAL']);
  const [stop] = parse(
    {
      messaging_product: 'whatsapp',
      user_preferences: [{ wa_id: PHONE, category: 'marketing_messages', value: 'stop', timestamp: time }],
    },
    { field: 'user_preferences', time },
  );
  assert.equal(stop.type, 'user.preference');
  assert.deepEqual(stop.data.peer.ids, [{ kind: 'wa_phone', value: PHONE }]);
  assert.deepEqual([stop.data.category, stop.data.value, stop.data.at], ['marketing_messages', 'stop', time * 1000]);
  assert.equal(stop.id.includes(PHONE), false, 'el id se guarda en claro: lleva la huella de la persona');
  assert.deepEqual(parse({ anything: 1 }, { field: 'security' }), [], 'un campo desconocido no produce eventos');
});

test('lector tolerante: acepta 1.0, 1.1 y la forma sin sobre; otra familia del contrato queda en cuarentena', () => {
  const old = { id: 'wamid.v10', type: 'message.inbound', data: { from: PHONE, to: NUMBER, text: 'Hola' } };
  for (const stored of [{ v: '1.0', event: old }, old, { v: '1.3', event: old }]) {
    const { event } = readStoredEvent(stored, 'meta');
    assert.deepEqual(event.data.peer, { ids: [{ kind: 'wa_phone', value: PHONE }], name: null, username: null });
    assert.deepEqual(event.data.account, {
      provider: 'meta-whatsapp',
      externalId: NUMBER,
      scopeId: null,
      displayPhone: null,
    });
    assert.equal(event.data.text, 'Hola', 'las claves de 1.0 no se tocan');
  }
  const [fresh] = parse(
    metaInboundValue(PHONE, 'wamid.v11', { type: 'text', text: { body: 'Hola' } }, { bsuid: BSUID }),
  );
  const read = readStoredEvent({ v: '1.1', event: fresh }, 'meta');
  assert.equal(read.v, '1.1');
  assert.deepEqual(read.event.data.peer, fresh.data.peer, 'lo que trajo el proveedor manda');
  const status = { id: 's:1', type: 'message.status', data: { providerRef: 'w', state: 'sent' } };
  assert.equal(withContract(status, 'meta'), status, 'sólo el entrante se completa');
  assert.throws(
    () => readStoredEvent({ v: '2.0', event: old }),
    e => e.permanent && e.message === 'contract_version',
  );
  assert.throws(
    () => readStoredEvent(null),
    e => e.permanent === true,
  );
});

test('contrato 1.1 de punta a punta: columnas canónicas del entrante y del estado, bitácora sin el número y cuarentena del entrante sin teléfono', async t => {
  const lab = await whatsappLab(t);
  const { db } = lab;
  const message = id => db.prepare('SELECT * FROM messages WHERE client_ref=?').get('meta:' + id);

  // 1) Un texto de hoy queda igual que antes, con content_kind «text» y sin nada más.
  const hello = await metaText(lab.origin(), PHONE, 'wamid.in-1', 'Hola, ¿qué cursos tienen?');
  assert.equal(hello.status, 200);
  const first = await until(() => message('wamid.in-1'), 'el primer mensaje entra');
  assert.deepEqual(
    [first.text, first.content_kind, first.reply, first.reply_to_id, first.forwarded, first.channel_meta],
    ['Hola, ¿qué cursos tienen?', 'text', null, null, 0, null],
  );
  // el asistente contesta por Meta: ese saliente tiene referencia del proveedor
  const out = await until(
    () =>
      db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id=? AND sender_kind!='customer' AND provider_ref LIKE 'wamid.out%' ORDER BY seq LIMIT 1",
        )
        .get(first.conversation_id),
    'la respuesta automática sale por Meta',
  );

  // 2) La persona cita esa respuesta y pulsa un botón de plantilla reenviado: pulsación, cita y reenvío en columnas.
  await metaInbound(
    lab.origin(),
    PHONE,
    'wamid.in-2',
    { type: 'button', button: { text: 'Ver fechas', payload: 'c:prueba:1' } },
    { replyTo: out.provider_ref, forwarded: true },
  );
  const pressed = await until(() => message('wamid.in-2'), 'la pulsación entra');
  assert.equal(pressed.text, 'Ver fechas', 'el texto se guarda como siempre');
  assert.equal(pressed.content_kind, 'interactive');
  assert.deepEqual(JSON.parse(pressed.reply), {
    kind: 'template_button',
    id: null,
    title: 'Ver fechas',
    payload: 'c:prueba:1',
    description: null,
  });
  assert.equal(pressed.reply_to_id, out.id, 'el mensaje citado se resuelve al del CRM');
  assert.equal(pressed.forwarded, 1);
  // citar algo que el CRM no tiene (p. ej. una plantilla de difusión) deja la referencia en channel_meta
  await metaText(lab.origin(), PHONE, 'wamid.in-3', 'Sobre tu mensaje', { replyTo: 'wamid.no-esta' });
  const quoted = await until(() => message('wamid.in-3'), 'la cita entra');
  assert.equal(quoted.reply_to_id, null);
  assert.deepEqual(JSON.parse(quoted.channel_meta), { replyTo: { providerRef: 'wamid.no-esta' } });

  // 3) Estado con tarificación y luego con fallo: wa_pricing y fail_code, sin cambiar el estado de siempre.
  const sent = await metaStatus(lab.origin(), out.provider_ref, 'delivered', { pricing: metaPricing('service') });
  assert.equal(sent.body.results[0].result, 'aplicado: mensaje delivered', 'el resultado de siempre');
  let row = db.prepare('SELECT * FROM messages WHERE id=?').get(out.id);
  assert.equal(row.delivery_state, 'delivered');
  assert.deepEqual(JSON.parse(row.wa_pricing), {
    billable: true,
    category: 'service',
    type: 'regular',
    model: 'PMP',
  });
  await metaStatus(lab.origin(), out.provider_ref, 'failed', {
    error: { code: 131026, title: 'Message undeliverable' },
  });
  row = db.prepare('SELECT * FROM messages WHERE id=?').get(out.id);
  assert.deepEqual([row.delivery_state, row.fail_code], ['failed', 131026]);
  assert.match(row.failed_reason, /no tiene WhatsApp/);
  // la bitácora de conectores guarda el estado con el número de la persona enmascarado
  const logged = JSON.parse(
    db.prepare('SELECT payload FROM connector_events WHERE event_id=?').get(out.provider_ref + ':failed').payload,
  );
  assert.deepEqual(logged.data.recipient, { phone: '…5678', userId: null });
  assert.equal(JSON.stringify(logged).includes(PHONE), false);

  // 4) Un aviso de plantilla todavía no lo atiende nadie: se registra una sola vez.
  const notice = await metaNotice(lab.origin(), 'message_template_status_update', {
    event: 'APPROVED',
    message_template_id: 777,
    message_template_name: 'aviso_novedad',
    message_template_language: 'es_MX',
  });
  assert.match(notice.body.results[0].result, /^registrado: todavía nada en el CRM atiende «template\.update»/);

  // 5) Sólo con identificador de usuario: cuarentena «no_phone» con su carga 1.1, sin crear cliente ni mensaje.
  const users = db.prepare('SELECT count(*) n FROM users').get().n;
  const blind = await metaInbound(
    lab.origin(),
    '',
    'wamid.in-bsuid',
    { type: 'text', text: { body: 'Hola' } },
    {
      bsuid: BSUID,
    },
  );
  assert.equal(blind.body.results[0].result, 'error: no_phone');
  const parked = lab.inboxRow('wamid.in-bsuid');
  assert.deepEqual([parked.state, parked.error], ['failed', 'no_phone']);
  const stored = JSON.parse(parked.payload);
  assert.equal(stored.v, '1.1');
  assert.deepEqual(stored.event.data.peer.ids, [{ kind: 'wa_bsuid', value: BSUID }]);
  assert.equal(db.prepare('SELECT count(*) n FROM users').get().n, users);
  assert.equal(message('wamid.in-bsuid'), undefined);
});
