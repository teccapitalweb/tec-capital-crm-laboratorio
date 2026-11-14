// Cimientos de difusiones (docs/PLAN_CIMIENTOS_DIFUSIONES.md). La ÚNICA reconstrucción de tablas de las difusiones,
// hecha una sola vez y antes de la primera campaña real (conciliación, filas 1 y 36; riesgo F-2):
//
//   wa_templates          columnas para la definición completa, la cuenta (waba_id) y el ciclo de Meta; la unicidad
//                         pasa de (name, language) a (waba_id, name, language). category deja de tener CHECK: se valida
//                         en código. Las plantillas de hoy quedan con waba_id '' y components armado de body/variables.
//   campaigns             dos tipos (kind 'catalogue', lo de hoy, y 'template', plantilla de Meta); template_id deja de
//                         ser obligatorio; estados en código (sin CHECK) para admitir pausa y detención sin otra
//                         reconstrucción.
//   campaign_recipients   un id propio, conversation_id y step_id opcionales (decisión D2: una difusión con plantilla
//                         no crea conversación, oportunidad ni tarea al enviar) y la cola de envío por destinatario.
//
// Y tablas nuevas, vacías salvo las semillas orientativas:
//   wa_account            hechos de cada cuenta de WhatsApp Business (zona de la cuota, límites, pago). Sin secretos.
//   wa_rates              tarifas por mercado y categoría con fecha de vigencia. Datos EDITABLES por administración;
//                         las semillas son orientativas (verified=0) y nunca se borran filas pasadas.
//   wa_pricing_rules      reglas de Meta con fecha de vigencia (servicio gratis por número, ventana gratuita por anuncio).
//   wa_message_costs      libro de costos: una fila por mensaje real (wamid) que Meta informó; sin importes.
//
// Marcada rebuild:true: el ejecutor apaga las claves foráneas, la aplica en una transacción y exige
// PRAGMA foreign_key_check vacío. rebuildTable conserva filas, índices y disparadores de cada tabla.
import { rebuildTable } from '../../named.mjs';

// 1 oct 2026 00:00 en Ciudad de México (UTC-6, sin horario de verano): desde ahí rigen las reglas de §7.2.
const OCT_2026 = Date.UTC(2026, 9, 1, 6);
const SEED_SOURCE =
  'Orientativa: cifra de terceros sin confirmar con Meta (diseño de difusiones §3.8). Administración debe sustituirla por la vigente.';
// Millonésimas de peso mexicano por mensaje entregado. Ejemplos para que el cálculo funcione desde el primer día; no
// son la verdad comercial: la tabla es editable y la interfaz dice «sin confirmar» mientras verified=0.
const SEED_RATES = { marketing: 729800, utility: 156500, authentication: 156500, service: 156500 };

function rebuildTemplates(db) {
  const old = [
    'id',
    'brand_id',
    'name',
    'language',
    'category',
    'purpose',
    'body',
    'variables',
    'status',
    'meta_id',
    'reject_reason',
    'revision',
    'created_by',
    'created_at',
    'updated_at',
    'synced_at',
  ];
  rebuildTable(db, 'wa_templates', {
    definition: `
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id),
      waba_id TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      language TEXT NOT NULL,
      category TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'manual' CHECK(purpose IN ('manual','notice')),
      body TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '[]',
      components TEXT,
      tpl_type TEXT NOT NULL DEFAULT 'standard',
      status TEXT NOT NULL DEFAULT 'draft',
      status_detail TEXT,
      status_at INTEGER,
      meta_id TEXT,
      reject_reason TEXT NOT NULL DEFAULT '',
      quality TEXT,
      quality_at INTEGER,
      prev_category TEXT,
      category_changed_at INTEGER,
      category_ack_at INTEGER,
      submitted_at INTEGER,
      approved_at INTEGER,
      header_handle TEXT,
      library_key TEXT,
      copied_from TEXT,
      archived_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id),
      updated_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      synced_at INTEGER,
      UNIQUE(waba_id,name,language)`,
    columns: old,
  });
  db.exec('CREATE INDEX wa_templates_meta ON wa_templates(meta_id) WHERE meta_id IS NOT NULL');
  // Definición completa a partir del cuerpo y sus variables (acotado: una instalación tiene decenas de plantillas).
  // Las muestras se completan al editar la plantilla; body y variables se siguen escribiendo para los lectores de hoy.
  const fill = db.prepare('UPDATE wa_templates SET components=? WHERE id=?');
  for (const t of db.prepare('SELECT id,body,variables FROM wa_templates WHERE components IS NULL').all()) {
    let keys = [];
    try {
      keys = JSON.parse(t.variables);
    } catch {
      keys = [];
    }
    const vars = (Array.isArray(keys) ? keys : []).map(key => ({ key: String(key), sample: null }));
    fill.run(
      JSON.stringify({
        type: 'standard',
        header: { type: 'none' },
        body: { text: t.body, vars },
        footer: null,
        buttons: [],
      }),
      t.id,
    );
  }
}

function rebuildCampaigns(db) {
  const old = [
    'id',
    'brand_id',
    'title',
    'template_id',
    'segment',
    'require_consent',
    'status',
    'scheduled_at',
    'audience_confirmed',
    'audience_size',
    'revision',
    'client_ref',
    'created_by',
    'created_at',
    'updated_at',
    'started_at',
    'launched_at',
    'finished_at',
  ];
  rebuildTable(db, 'campaigns', {
    definition: `
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL REFERENCES brands(id),
      kind TEXT NOT NULL DEFAULT 'catalogue',
      title TEXT NOT NULL,
      template_id TEXT REFERENCES content_templates(id),
      wa_template_id TEXT REFERENCES wa_templates(id),
      wa_number TEXT REFERENCES wa_numbers(phone_number_id),
      content TEXT NOT NULL DEFAULT '{}',
      segment TEXT NOT NULL DEFAULT '{}',
      require_consent INTEGER NOT NULL DEFAULT 1,
      options TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'draft',
      status_reason TEXT,
      resume_status TEXT,
      scheduled_at INTEGER,
      timezone TEXT,
      audience_confirmed INTEGER,
      audience_size INTEGER NOT NULL DEFAULT 0,
      cost_estimate TEXT,
      batch_no INTEGER NOT NULL DEFAULT 0,
      batch_release_at INTEGER,
      retry_until INTEGER,
      parent_id TEXT REFERENCES campaigns(id),
      parent_filter TEXT,
      revision INTEGER NOT NULL DEFAULT 1,
      client_ref TEXT UNIQUE,
      created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      started_at INTEGER,
      launched_at INTEGER,
      finished_at INTEGER`,
    columns: old,
  });
  db.exec(`
    CREATE INDEX campaigns_calendar ON campaigns(brand_id,scheduled_at);
    CREATE INDEX campaigns_parent ON campaigns(parent_id) WHERE parent_id IS NOT NULL;
    CREATE INDEX campaigns_kind ON campaigns(kind,status);
  `);
}

function rebuildRecipients(db) {
  const old = ['campaign_id', 'contact_id', 'conversation_id', 'step_id', 'created_at'];
  rebuildTable(db, 'campaign_recipients', {
    // id con valor por omisión: cada fila copiada recibe uno nuevo, y un INSERT de hoy (sin id) sigue funcionando.
    definition: `
      id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
      campaign_id TEXT NOT NULL REFERENCES campaigns(id),
      contact_id TEXT NOT NULL REFERENCES contacts(id),
      conversation_id TEXT REFERENCES conversations(id),
      step_id TEXT REFERENCES automation_steps(id),
      enrolled INTEGER NOT NULL DEFAULT 1,
      state TEXT,
      position INTEGER,
      batch_no INTEGER NOT NULL DEFAULT 0,
      wa_to TEXT,
      wa_recipient TEXT,
      wa_id TEXT,
      next_at INTEGER,
      attempts INTEGER NOT NULL DEFAULT 0,
      lease_owner TEXT,
      lease_until INTEGER,
      provider_ref TEXT,
      params TEXT,
      rendered TEXT,
      message_id TEXT REFERENCES messages(id),
      skip_reason TEXT,
      fail_code INTEGER,
      fail_kind TEXT,
      fail_reason TEXT,
      sent_at INTEGER,
      delivered_at INTEGER,
      read_at INTEGER,
      failed_at INTEGER,
      replied_at INTEGER,
      reply_kind TEXT,
      clicked_at INTEGER,
      click_label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      UNIQUE(campaign_id,contact_id)`,
    columns: old,
  });
  db.exec(`
    CREATE INDEX campaign_recipients_state ON campaign_recipients(campaign_id,state);
    CREATE INDEX campaign_recipients_due ON campaign_recipients(state,next_at) WHERE state IN ('queued','deferred');
    CREATE INDEX campaign_recipients_lease ON campaign_recipients(lease_until) WHERE state='sending';
    CREATE UNIQUE INDEX campaign_recipients_ref ON campaign_recipients(provider_ref) WHERE provider_ref IS NOT NULL;
    CREATE UNIQUE INDEX campaign_recipients_to ON campaign_recipients(campaign_id,wa_to) WHERE wa_to IS NOT NULL;
    CREATE INDEX campaign_recipients_wa ON campaign_recipients(wa_id,sent_at) WHERE wa_id IS NOT NULL;
    CREATE INDEX campaign_recipients_contact ON campaign_recipients(contact_id,created_at);
    CREATE INDEX campaign_recipients_conversation ON campaign_recipients(conversation_id) WHERE conversation_id IS NOT NULL;
  `);
}

function createCostTables(db) {
  db.exec(`
    CREATE TABLE wa_account(
      waba_id TEXT PRIMARY KEY,
      label TEXT NOT NULL DEFAULT '',
      business_id TEXT,
      mode TEXT NOT NULL DEFAULT 'live',
      currency TEXT NOT NULL DEFAULT 'MXN',
      timezone TEXT NOT NULL DEFAULT 'America/Mexico_City',
      messaging_limit TEXT,
      limit_value INTEGER,
      limit_source TEXT,
      template_limit INTEGER NOT NULL DEFAULT 250,
      payment_status TEXT NOT NULL DEFAULT 'unknown',
      payment_note TEXT,
      payment_at INTEGER,
      pricing_policy TEXT,
      review_status TEXT,
      connection_id TEXT,
      remote_cache TEXT,
      remote_at INTEGER,
      revision INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE wa_rates(
      id TEXT PRIMARY KEY,
      market TEXT NOT NULL,
      category TEXT NOT NULL,
      currency TEXT NOT NULL,
      rate_micros INTEGER NOT NULL CHECK(rate_micros>=0),
      effective_from INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL,
      UNIQUE(market,category,effective_from)
    );
    CREATE TABLE wa_pricing_rules(
      effective_from INTEGER PRIMARY KEY,
      free_service_per_number INTEGER NOT NULL CHECK(free_service_per_number>=0),
      free_entry_days INTEGER NOT NULL CHECK(free_entry_days>=0),
      free_entry_reply_hours INTEGER NOT NULL CHECK(free_entry_reply_hours>=0),
      service_charged INTEGER NOT NULL,
      utility_in_window_free INTEGER NOT NULL,
      verified INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      created_by TEXT REFERENCES users(id),
      created_at INTEGER NOT NULL
    );
    CREATE TABLE wa_message_costs(
      provider_ref TEXT PRIMARY KEY,
      phone_number_id TEXT NOT NULL,
      brand_id TEXT NOT NULL REFERENCES brands(id),
      market TEXT NOT NULL,
      origin TEXT NOT NULL,
      campaign_id TEXT,
      category TEXT NOT NULL,
      category_source TEXT NOT NULL DEFAULT 'crm',
      price_type TEXT,
      billable INTEGER,
      delivered_at INTEGER,
      created_at INTEGER NOT NULL
    ) WITHOUT ROWID;
    CREATE INDEX wa_message_costs_number ON wa_message_costs(phone_number_id,delivered_at);
    CREATE INDEX wa_message_costs_brand ON wa_message_costs(brand_id,delivered_at,category);
    CREATE INDEX wa_message_costs_campaign ON wa_message_costs(campaign_id) WHERE campaign_id IS NOT NULL;
  `);
  const rate = db.prepare(
    'INSERT INTO wa_rates(id,market,category,currency,rate_micros,effective_from,verified,source,created_at) VALUES(?,?,?,?,?,?,0,?,?)',
  );
  for (const market of ['MX', '*'])
    for (const [category, micros] of Object.entries(SEED_RATES))
      rate.run(
        'seed-' + (market === '*' ? 'any' : market.toLowerCase()) + '-' + category + '-2026-10',
        market,
        category,
        'MXN',
        micros,
        OCT_2026,
        SEED_SOURCE,
        OCT_2026,
      );
  db.prepare(
    'INSERT INTO wa_pricing_rules(effective_from,free_service_per_number,free_entry_days,free_entry_reply_hours,service_charged,utility_in_window_free,verified,note,created_at) VALUES(?,1000,7,24,1,0,0,?,?)',
  ).run(
    OCT_2026,
    'Desde el 1 oct 2026: 1,000 mensajes de servicio gratis al mes por número; después se cobran. Entrada por anuncio: hasta 7 días sin costo si se responde en 24 h. Sin confirmar: revisar con la página de precios de Meta.',
    OCT_2026,
  );
}

export default {
  name: 'broadcasts/0001-foundations',
  after: [],
  rebuild: true,
  up(db) {
    rebuildTemplates(db);
    rebuildCampaigns(db);
    rebuildRecipients(db);
    createCostTables(db);
  },
};
