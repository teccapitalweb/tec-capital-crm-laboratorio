// Cimientos de difusiones (docs/PLAN_CIMIENTOS_DIFUSIONES.md): la reconstrucción de campaigns, campaign_recipients y
// wa_templates sobre una base publicada con datos, el motor de costo (reglas, cuota de 1,000 por número, mercados,
// libro alimentado por los estados de Meta, medidor) y la decisión D2 (una difusión no crea oportunidades ni tareas).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';
import { migrate, NAMED } from '../server/migrations/index.mjs';
import { defineRegistry } from '../server/migrations/named.mjs';
import { marketOf, monthOf, monthRange, splitGroup } from '../server/modules/wa-costs/model.mjs';
import { assertSchemaCurrent, schemaShape } from './helpers/schema.mjs';
import { call, sleep, until, whatsappLab } from './helpers/crm.mjs';
import { NUMBER, metaPricing, metaStatus, metaText } from './helpers/fake-meta.mjs';

const NEW = /^(broadcasts|messages)\//; // lo que este encargo añade sobre lo publicado en main

async function workspace(t) {
  const dir = await mkdtemp(join(tmpdir(), 'crm-difusiones-'));
  const db = openDatabase(dir);
  t.after(async () => {
    db.close();
    await rm(dir, { recursive: true, force: true });
  });
  return db;
}

// Una base como la publicada (escalera 41 + migraciones con nombre de main) con campañas, destinatarios, bitácora y
// plantillas de WhatsApp.
function populate(db) {
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  run(
    "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('u-admin','admin','Administración','x','admin',1,1,1),('u-cli','cli','Cliente','x','customer',2,1,1)",
  );
  run(
    "INSERT INTO contacts(id,brand_id,source_user_id,name,created_at,updated_at) VALUES('ct-1','globalvet','u-cli','Cliente',1,1),('ct-2','globalvet',NULL,'Importado',1,1)",
  );
  run(
    "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES('cv-1','u-cli','globalvet','aves','whatsapp',1,1)",
  );
  run(
    "INSERT INTO automation_steps(id,brand_id,conversation_id,kind,dedupe_key,state,scheduled_at,next_attempt_at,created_at,updated_at) VALUES('st-1','globalvet','cv-1','campaign.send','campaign:camp-done:ct-1','completed',1,1,1,1)",
  );
  run(
    "INSERT INTO campaigns(id,brand_id,title,template_id,status,audience_size,client_ref,created_by,created_at,updated_at,started_at,launched_at,finished_at) VALUES('camp-done','globalvet','Noviembre','seed-globalvet-info','completed',1,'ref-1','u-admin',10,20,11,12,13)",
  );
  run(
    "INSERT INTO campaigns(id,brand_id,title,template_id,status,scheduled_at,created_at,updated_at) VALUES('camp-draft','globalvet','Borrador','seed-globalvet-price','draft',99,30,30)",
  );
  run(
    "INSERT INTO campaign_recipients(campaign_id,contact_id,conversation_id,step_id,created_at) VALUES('camp-done','ct-1','cv-1','st-1',12)",
  );
  run(
    "INSERT INTO campaign_events(campaign_id,kind,details,actor_id,created_at) VALUES('camp-done','queued','{\"recipients\":1}',NULL,12)",
  );
  run(
    "INSERT INTO wa_templates(id,brand_id,name,language,category,purpose,body,variables,status,meta_id,created_at,updated_at) VALUES('wt-1','globalvet','aviso_novedad','es_MX','utility','notice','Hola {{1}}, hay novedades de {{2}}.','[\"nombre\",\"curso\"]','approved','555',1,2),('wt-2','globalvet','promo','es_MX','marketing','manual','Promoción','[]','draft',NULL,3,4)",
  );
  run(
    "INSERT INTO wa_numbers(phone_number_id,brand_id,course_id,label,created_at,updated_at) VALUES('109000000000001','globalvet','aves','Ventas',1,1)",
  );
  // un disparador de la propia tabla (como los que crean otros frentes al arrancar), para ver que sobrevive
  db.exec('CREATE TRIGGER campaigns_audit_probe AFTER UPDATE OF title ON campaigns BEGIN SELECT 1; END');
}

const pick = (row, keys) => Object.fromEntries(keys.map(k => [k, row[k]]));

test('broadcasts/0001: reconstruye campañas, destinatarios y plantillas sobre una base publicada con datos', async t => {
  const db = await workspace(t);
  migrate(db, { backup: false, registry: defineRegistry(NAMED.filter(m => !NEW.test(m.name))) });
  populate(db);
  const before = {
    campaigns: db
      .prepare('SELECT * FROM campaigns ORDER BY id')
      .all()
      .map(r => ({ ...r })),
    recipients: db
      .prepare('SELECT * FROM campaign_recipients')
      .all()
      .map(r => ({ ...r })),
    templates: db
      .prepare('SELECT * FROM wa_templates ORDER BY id')
      .all()
      .map(r => ({ ...r })),
    events: db
      .prepare('SELECT * FROM campaign_events')
      .all()
      .map(r => ({ ...r })),
    triggers: db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all()
      .map(r => ({ ...r })),
  };

  const result = migrate(db, { backup: false });
  assert.ok(result.applied.includes('broadcasts/0001-foundations'));
  assertSchemaCurrent(db);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'claves foráneas íntegras');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, 'el ejecutor las vuelve a encender');
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');

  // filas intactas, con los valores nuevos por omisión
  const campaigns = db.prepare('SELECT * FROM campaigns ORDER BY id').all();
  assert.equal(campaigns.length, 2);
  for (const [i, old] of before.campaigns.entries()) {
    assert.deepEqual(pick(campaigns[i], Object.keys(old)), old);
    assert.deepEqual(
      [campaigns[i].kind, campaigns[i].content, campaigns[i].options, campaigns[i].batch_no],
      ['catalogue', '{}', '{}', 0],
    );
  }
  const recipients = db.prepare('SELECT * FROM campaign_recipients').all();
  assert.deepEqual(pick(recipients[0], Object.keys(before.recipients[0])), before.recipients[0]);
  assert.match(recipients[0].id, /^[0-9a-f]{32}$/, 'cada destinatario copiado recibe su id');
  assert.deepEqual([recipients[0].enrolled, recipients[0].state, recipients[0].attempts], [1, null, 0]);
  const templates = db.prepare('SELECT * FROM wa_templates ORDER BY id').all();
  for (const [i, old] of before.templates.entries()) assert.deepEqual(pick(templates[i], Object.keys(old)), old);
  assert.equal(templates[0].waba_id, '');
  assert.deepEqual(JSON.parse(templates[0].components), {
    type: 'standard',
    header: { type: 'none' },
    body: {
      text: 'Hola {{1}}, hay novedades de {{2}}.',
      vars: [
        { key: 'nombre', sample: null },
        { key: 'curso', sample: null },
      ],
    },
    footer: null,
    buttons: [],
  });
  assert.deepEqual(
    db
      .prepare('SELECT * FROM campaign_events')
      .all()
      .map(r => ({ ...r })),
    before.events,
  );

  // disparadores (propios y de otras tablas) e índices conservados
  assert.deepEqual(
    db
      .prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all()
      .map(r => ({ ...r })),
    before.triggers,
  );
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL")
    .all()
    .map(r => r.name);
  for (const name of [
    'campaigns_brand',
    'campaigns_due',
    'campaigns_calendar',
    'campaign_recipients_step',
    'campaign_recipients_ref',
    'wa_templates_brand',
    'wa_templates_meta',
    'wa_message_costs_number',
  ])
    assert.ok(indexes.includes(name), name);

  // las restricciones nuevas funcionan
  assert.throws(() => db.prepare("DELETE FROM campaigns WHERE id='camp-done'").run(), /FOREIGN KEY/);
  db.prepare("UPDATE campaigns SET status='paused' WHERE id='camp-draft'").run();
  db.prepare(
    "INSERT INTO campaigns(id,brand_id,kind,title,wa_template_id,wa_number,created_at,updated_at) VALUES('camp-tpl','globalvet','template','Difusión','wt-1','109000000000001',1,1)",
  ).run();
  db.prepare(
    "INSERT INTO campaign_recipients(campaign_id,contact_id,state,wa_to,created_at) VALUES('camp-tpl','ct-2','queued','525512345678',1)",
  ).run();
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO campaign_recipients(campaign_id,contact_id,created_at) VALUES('camp-tpl','ct-2',1)")
        .run(),
    /UNIQUE/,
  );
  db.prepare(
    "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,created_at,updated_at) VALUES('wt-3','globalvet','1234567890','aviso_novedad','es_MX','utility','Hola',1,1)",
  ).run();
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,created_at,updated_at) VALUES('wt-4','globalvet','1234567890','aviso_novedad','es_MX','utility','Otra',1,1)",
        )
        .run(),
    /UNIQUE/,
    'misma cuenta, mismo nombre e idioma',
  );
  // tarifas y reglas orientativas, sin confirmar
  assert.deepEqual(
    db
      .prepare('SELECT DISTINCT verified FROM wa_rates')
      .all()
      .map(r => r.verified),
    [0],
  );
  assert.equal(db.prepare('SELECT count(*) n FROM wa_rates').get().n, 8);
  assert.equal(db.prepare('SELECT free_service_per_number n FROM wa_pricing_rules').get().n, 1000);

  // idempotente
  assert.deepEqual(migrate(db, { backup: false }).applied, []);

  // la misma forma que una base nueva (salvo el disparador de prueba)
  const fresh = await workspace(t);
  migrate(fresh, { backup: false });
  const shape = d => schemaShape(d).filter(o => o.name !== 'campaigns_audit_probe');
  assert.deepEqual(shape(db), shape(fresh));
});

test('reglas del costo: mercado por prefijo, mes en la zona de la cuenta y cuota de servicio por número', () => {
  assert.equal(marketOf('5215512345678'), 'MX');
  assert.equal(marketOf('+1 555 010 0000'), 'US');
  assert.equal(marketOf('593991234567'), 'EC');
  assert.equal(marketOf('4915112345678'), '*');
  assert.equal(marketOf(''), '*');
  const tz = 'America/Mexico_City';
  const nov = monthRange('2026-11', tz);
  assert.equal(nov.from, Date.UTC(2026, 10, 1, 6), 'medianoche del 1 de noviembre en Ciudad de México');
  assert.equal(nov.to, Date.UTC(2026, 11, 1, 6));
  assert.equal(monthOf(Date.UTC(2026, 10, 1, 5, 30), tz), '2026-10', 'las 23:30 del 31 de octubre siguen en octubre');
  assert.equal(monthOf(Date.UTC(2026, 10, 1, 6, 0), tz), '2026-11');
  assert.equal(monthRange('2026-13', tz), null);
  const ny = monthRange('2026-11', 'America/New_York');
  assert.equal(ny.from, Date.UTC(2026, 10, 1, 4), 'con horario de verano también');
  const rules = { service_charged: 1 };
  const quota = { left: 1000 };
  assert.deepEqual(splitGroup({ category: 'service', billable: null, count: 990 }, quota, rules), {
    free: 990,
    billable: 0,
    usedQuota: 990,
  });
  assert.deepEqual(
    splitGroup({ category: 'service', priceType: 'free_customer_service', billable: 0, count: 5 }, quota, rules),
    { free: 5, billable: 0, usedQuota: 5 },
    'lo que Meta dio gratis también gasta cuota',
  );
  assert.deepEqual(splitGroup({ category: 'service', billable: null, count: 20 }, quota, rules), {
    free: 5,
    billable: 15,
    usedQuota: 5,
  });
  assert.deepEqual(splitGroup({ category: 'service', billable: null, count: 3 }, quota, { service_charged: 0 }), {
    free: 0,
    billable: 0,
    usedQuota: 0,
  });
  assert.deepEqual(splitGroup({ category: 'marketing', billable: null, count: 4 }, quota, rules), {
    free: 0,
    billable: 4,
    usedQuota: 0,
  });
  assert.deepEqual(
    splitGroup({ category: 'marketing', priceType: 'free_entry_point', billable: null, count: 4 }, quota, rules),
    { free: 4, billable: 0, usedQuota: 0 },
    'entrada por anuncio: gratis',
  );
  assert.deepEqual(splitGroup({ category: 'utility', billable: 1, count: 2 }, quota, rules).billable, 2);
});

test('libro de costos y medidor de punta a punta: estados de Meta con su tarificación, 1,000 gratis por número, mercados y aviso de cuota; una difusión no crea oportunidades ni tareas', async t => {
  const lab = await whatsappLab(t);
  const { db } = lab;
  const admin = lab.admin;
  const api = (path, options = {}) => call(lab.origin(), path, { cookie: admin, ...options });
  // regla propia vigente desde siempre (la cuota no depende del reloj) y tarifas propias vigentes desde hace dos horas:
  // así mandan sobre las semillas orientativas, porque gana la fila de vigencia más reciente
  const since = Date.now() - 2 * 3_600_000;
  await api('/api/wa-costs/rules', {
    body: { effectiveFrom: 0, freeServicePerNumber: 1000, freeEntryDays: 7, freeEntryReplyHours: 24, verified: true },
    expected: 201,
  });
  const rate = (market, category, rateMicros) =>
    api('/api/wa-costs/rates', {
      body: { market, category, rateMicros, effectiveFrom: since, verified: true },
      expected: 201,
    });
  await rate('MX', 'marketing', 800_000);
  await rate('MX', 'service', 100_000);
  await rate('*', 'marketing', 1_000_000);
  const again = await rate('MX', 'marketing', 800_000);
  assert.equal(again.rate.rate_micros, 800_000, 'repetir la misma alta no duplica');
  await api('/api/wa-costs/rates', {
    body: { market: 'MX', category: 'marketing', rateMicros: 1, effectiveFrom: since },
    expected: 409,
  });
  await api('/api/wa-costs/rates', {
    body: { market: 'MEX', category: 'marketing', rateMicros: 1, effectiveFrom: since },
    expected: 400,
  });

  // una conversación real: el asistente responde por Meta
  await metaText(lab.origin(), '5215512345678', 'wamid.c-1', 'Hola, ¿qué cursos tienen?');
  const out = await until(
    () =>
      db
        .prepare(
          "SELECT * FROM messages WHERE sender_kind!='customer' AND provider_ref LIKE 'wamid.out%' ORDER BY seq LIMIT 1",
        )
        .get(),
    'sale la respuesta por Meta',
  );
  const counts = () =>
    ['conversations', 'opportunities', 'tasks', 'contacts'].map(
      table => db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    );
  const baseline = counts();

  // estados de Meta → libro de costos: «sent» crea la fila, «delivered» la completa, «read» no la duplica
  await metaStatus(lab.origin(), out.provider_ref, 'sent', {
    pricing: metaPricing('service', { billable: false, type: 'free_customer_service' }),
  });
  let cost = db.prepare('SELECT * FROM wa_message_costs WHERE provider_ref=?').get(out.provider_ref);
  assert.deepEqual(
    [
      cost.origin,
      cost.category,
      cost.category_source,
      cost.price_type,
      cost.billable,
      cost.market,
      cost.phone_number_id,
      cost.delivered_at,
    ],
    ['chat', 'service', 'meta', 'free_customer_service', 0, 'MX', NUMBER, null],
  );
  await metaStatus(lab.origin(), out.provider_ref, 'delivered');
  await metaStatus(lab.origin(), out.provider_ref, 'read');
  cost = db.prepare('SELECT * FROM wa_message_costs WHERE provider_ref=?').get(out.provider_ref);
  assert.ok(cost.delivered_at > 0);
  assert.equal(cost.billable, 0, 'un dato que ya estaba no se borra');
  assert.equal(db.prepare('SELECT count(*) n FROM wa_message_costs').get().n, 1);
  // un estado de algo que no es del CRM no escribe nada
  await metaStatus(lab.origin(), 'wamid.ajeno', 'delivered', { pricing: metaPricing('marketing') });
  assert.equal(db.prepare('SELECT count(*) n FROM wa_message_costs').get().n, 1);

  // D2: una difusión con plantilla programada, con destinatarios sin conversación. El motor de campañas de catálogo
  // no la toca y no nace ninguna conversación, oportunidad ni tarea; el estado de Meta de su envío va al libro.
  const t0 = Date.now();
  db.prepare(
    "INSERT INTO contacts(id,brand_id,name,phone,phone_key,created_at,updated_at) VALUES('ct-imp-1','globalvet','Importada','+525511112222','525511112222',?,?),('ct-imp-2','globalvet','Importado','+12025550100','12025550100',?,?)",
  ).run(t0, t0, t0, t0);
  db.prepare(
    "INSERT INTO campaigns(id,brand_id,kind,title,wa_number,status,scheduled_at,created_at,updated_at) VALUES('11111111-2222-4333-8444-555555555555','globalvet','template','Difusión de prueba',?,'scheduled',?,?,?)",
  ).run(NUMBER, t0 - 1000, t0, t0);
  db.prepare(
    "INSERT INTO campaign_recipients(campaign_id,contact_id,state,wa_to,provider_ref,sent_at,created_at) VALUES('11111111-2222-4333-8444-555555555555','ct-imp-1','sent','525511112222','wamid.dif-1',?,?),('11111111-2222-4333-8444-555555555555','ct-imp-2','sent','12025550100','wamid.dif-2',?,?)",
  ).run(t0, t0, t0, t0);
  const baselineWithImports = counts();
  await sleep(2500); // varias pasadas del reloj de campañas
  assert.equal(
    db.prepare("SELECT status FROM campaigns WHERE id='11111111-2222-4333-8444-555555555555'").get().status,
    'scheduled',
    'el motor de catálogo no la lanza',
  );
  assert.deepEqual(counts(), baselineWithImports, 'ni conversaciones, ni oportunidades, ni tareas');
  assert.deepEqual(baselineWithImports.slice(0, 3), baseline.slice(0, 3));
  const listed = await api('/api/campaigns');
  assert.equal(
    listed.campaigns.some(c => c.id === '11111111-2222-4333-8444-555555555555'),
    false,
  );
  await api('/api/campaigns/11111111-2222-4333-8444-555555555555', { expected: 404 });
  await metaStatus(lab.origin(), 'wamid.dif-1', 'delivered', {
    recipient: '5215511112222',
    pricing: metaPricing('marketing'),
  });
  await metaStatus(lab.origin(), 'wamid.dif-2', 'delivered', {
    recipient: '12025550100',
    pricing: metaPricing('marketing'),
  });
  const dif = db.prepare("SELECT * FROM wa_message_costs WHERE provider_ref='wamid.dif-1'").get();
  assert.deepEqual(
    [dif.origin, dif.campaign_id, dif.category, dif.market, dif.billable, dif.brand_id],
    ['campaign', '11111111-2222-4333-8444-555555555555', 'marketing', 'MX', 1, 'globalvet'],
  );
  assert.equal(db.prepare("SELECT market FROM wa_message_costs WHERE provider_ref='wamid.dif-2'").get().market, 'US');
  assert.deepEqual(counts(), baselineWithImports, 'el estado de una difusión tampoco crea nada');

  // la cuota de 1,000 por número: 1,004 mensajes de servicio entregados este mes sin dato de Meta, más el gratis
  const insert = db.prepare(
    "INSERT INTO wa_message_costs(provider_ref,phone_number_id,brand_id,market,origin,category,billable,delivered_at,created_at) VALUES(?,?,'globalvet','MX','chat','service',NULL,?,?)",
  );
  const now = Date.now();
  for (let i = 0; i < 1004; i++) insert.run('wamid.srv-' + i, NUMBER, now - 1000, now);
  const { meter } = await api('/api/wa-costs/meter?brand=globalvet');
  const number = meter.numbers.find(n => n.phoneNumberId === NUMBER);
  assert.deepEqual(number.service, { delivered: 1005, free: 1000, usedFree: 1000, billable: 5, pct: 100 });
  const byCategory = Object.fromEntries(number.byCategory.map(c => [c.category, c]));
  assert.equal(byCategory.service.cost.micros, 5 * 100_000, '5 de servicio por encima de la cuota, a la tarifa de MX');
  assert.equal(
    byCategory.marketing.cost.micros,
    800_000 + 1_000_000,
    'MX a su tarifa; US a la de cualquier otro mercado',
  );
  assert.equal(meter.total.micros, 5 * 100_000 + 1_800_000);
  assert.equal(meter.brands[0].campaignCost.micros, 1_800_000);
  assert.equal(meter.timezone, 'America/Mexico_City');
  assert.equal(meter.ratesVerified, false, 'la tarifa de utilidad de México sigue siendo la orientativa');
  await api('/api/wa-costs/meter?brand=globalvet&month=2026-13', { expected: 400 });
  await api('/api/wa-costs/meter?brand=no-existe', { expected: 404 });

  // aviso de cuota: un mensaje de servicio real más cruza los umbrales (una sola vez cada uno)
  await metaText(lab.origin(), '5215512345678', 'wamid.c-2', '¿Y el precio?');
  const second = await until(
    () =>
      db
        .prepare(
          "SELECT * FROM messages WHERE sender_kind!='customer' AND provider_ref LIKE 'wamid.out%' AND provider_ref!=? ORDER BY seq LIMIT 1",
        )
        .get(out.provider_ref),
    'sale otra respuesta',
  );
  // Meta la clasifica como servicio y no dice si se cobra: cuenta contra la cuota
  await metaStatus(lab.origin(), second.provider_ref, 'delivered', {
    pricing: { pricing_model: 'PMP', category: 'service', type: 'regular' },
  });
  const notices = db
    .prepare("SELECT payload FROM domain_events WHERE type='whatsapp.cuota_servicio' ORDER BY seq")
    .all()
    .map(r => JSON.parse(r.payload));
  assert.deepEqual(
    notices.map(n => [n.phoneNumberId, n.threshold, n.free]),
    [
      [NUMBER, 80, 1000],
      [NUMBER, 100, 1000],
    ],
  );
});
