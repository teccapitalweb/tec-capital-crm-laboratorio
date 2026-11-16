import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Pantalla «Difusiones» (public/screens/difusiones, en vista previa): lista, asistente (plantilla → audiencia → valores
// → revisar con los excluidos por motivo) y detalle de un ENSAYO, que recorre todo sin enviar nada (la prueba corre sin
// WhatsApp real). La plantilla aprobada, los contactos y la lista son inventados y se escriben en la base de la prueba.
const BRAND = 'globalvet';
const PLANTILLA = 'difusion_ui_prueba';

function sembrar() {
  const db = new DatabaseSync(join(process.env.CRM_UI_DATA_DIR, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    if (db.prepare('SELECT 1 FROM wa_templates WHERE name=?').get(PLANTILLA)) return;
    const t = Date.now();
    const components = {
      type: 'standard',
      header: { type: 'none' },
      body: {
        text: 'Hola {{1}}, abrimos inscripciones de {{2}}.',
        vars: [
          { key: 'nombre', sample: 'Ana', fallback: null },
          { key: 'curso', sample: 'Aves', fallback: null },
        ],
      },
      footer: { text: 'Responde BAJA para no recibir más.' },
      buttons: [
        { type: 'quick_reply', text: 'Me interesa' },
        { type: 'quick_reply', text: 'No, gracias' },
      ],
    };
    db.prepare(
      "INSERT INTO wa_templates(id,brand_id,waba_id,name,language,category,body,variables,components,status,revision,created_at,updated_at) VALUES(?,?,'',?,'es_MX','marketing',?,'[]',?,'approved',1,?,?)",
    ).run(randomUUID(), BRAND, PLANTILLA, components.body.text, JSON.stringify(components), t, t);
    const lista = randomUUID();
    db.prepare(
      "INSERT INTO audiences(id,brand_id,kind,role,name,name_key,definition,member_count,created_at,updated_at) VALUES(?,?,'list','audience','Difusión de prueba','difusion de prueba','{}',6,?,?)",
    ).run(lista, BRAND, t, t);
    for (let i = 0; i < 6; i++) {
      const id = 'ui-dif-' + i;
      const key = '5255400000' + (10 + i);
      db.prepare(
        "INSERT INTO contacts(id,brand_id,name,phone,phone_key,source,created_at,updated_at) VALUES(?,?,?,?,?,'import',?,?)",
      ).run(id, BRAND, 'Persona Difusión ' + i, '+' + key, key, t, t);
      if (i > 0)
        db.prepare(
          "INSERT INTO contact_consent(contact_id,brand_id,status,source,updated_at) VALUES(?,?,'opted_in','prueba',?)",
        ).run(id, BRAND, t);
      db.prepare("INSERT INTO audience_members(audience_id,contact_id,source,added_at) VALUES(?,?,'manual',?)").run(
        lista,
        id,
        t,
      );
    }
  } finally {
    db.close();
  }
}

test.beforeEach(async ({ page, baseURL }) => {
  sembrar();
  const headers = { Origin: baseURL };
  const get = async path => {
    const r = await page.request.get(path, { headers });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const patch = async (path, data) => {
    const r = await page.request.patch(path, { headers, data });
    expect(r.ok(), await r.text()).toBe(true);
  };
  const campaigns = (await get('/api/campaigns/settings')).settings.find(s => s.brand_id === BRAND);
  if (!campaigns.enabled)
    await patch('/api/campaigns/settings/' + BRAND, { enabled: true, expectedRevision: campaigns.revision });
  const auto = (await get('/api/automation')).brands.find(b => b.id === BRAND);
  if (!auto.enabled) await patch('/api/automation/brands/' + BRAND, { enabled: true, expectedRevision: auto.revision });
  const ajustes = (await get('/api/broadcasts/settings?brand=' + BRAND)).settings;
  if (ajustes.quietStart !== ajustes.quietEnd)
    await patch('/api/broadcasts/settings/' + BRAND, {
      quietStart: '00:00',
      quietEnd: '00:00',
      expectedRevision: ajustes.revision,
    });
});

test('Difusiones: asistente de un ensayo, revisión con excluidos y detalle con su avance', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="difusiones"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Difusiones');
  const marca = page.locator('#page form[data-do="marca"] select');
  await expect(marca).toBeVisible(); // la prueba arranca con varias marcas: elige la de los datos
  await marca.selectOption(BRAND);
  await expect(page.locator('#page [data-slot="tabla"]')).toBeVisible();
  await settled(page);
  await expectNiebla(page, 'difusiones', testInfo);

  // Asistente: plantilla, audiencia, valores y revisión.
  await page.locator('#page [data-do="nueva"]').click();
  const asistente = page.locator('#page [data-slot="asistente"]');
  await expect(asistente).toContainText('Plantilla aprobada');
  await asistente.locator('[name="plantilla"]').selectOption({ label: `${PLANTILLA} · Promoción` });
  await asistente.locator('[name="curso"]').selectOption('nutricion');
  await expect(asistente.locator('[name="modo"]')).toHaveValue('rehearsal');
  await expect(asistente.locator('.dif-telefono')).toContainText('abrimos inscripciones');
  await settled(page);
  await expectNiebla(page, 'difusiones-asistente', testInfo);
  await asistente.locator('[data-do="k-wz-next"]').click();
  await asistente.locator('[name="incluir"]').selectOption({ label: 'Difusión de prueba (6)' });
  await asistente.locator('[data-do="k-wz-next"]').click();
  await expect(asistente).toContainText('Primer nombre del contacto');
  await asistente.locator('[name="ritmo"]').fill('600');
  await asistente.locator('[data-do="k-wz-next"]').click();
  await expect(asistente).toContainText('personas recibirán el mensaje');
  await expect(asistente).toContainText('Sin consentimiento registrado: 1');
  await settled(page);
  await expectNiebla(page, 'difusiones-revisar', testInfo);
  await asistente.locator('[data-do="k-wz-next"]').click();

  // Detalle: ensayo en curso o terminado, con sus destinatarios.
  await expect(page.locator('#page')).toContainText('Ensayo: no se envía nada');
  await expect(page.locator('#page')).toContainText('Completada', { timeout: 15000 });
  await expect(page.locator('#page [aria-label="Destinatarios"]')).toContainText('Persona Difusión');
  await settled(page);
  await expectNiebla(page, 'difusiones-detalle', testInfo);

  // Un destinatario al que se le escribió por su identificador (sin teléfono) y una difusión detenida porque el
  // número volvió al modo escucha. Se simula en la base: un ensayo no usa identificadores ni cambia de número.
  const db = new DatabaseSync(join(process.env.CRM_UI_DATA_DIR, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    const { id } = db
      .prepare(
        'SELECT c.id FROM campaigns c JOIN wa_templates t ON t.id=c.wa_template_id WHERE t.name=? ORDER BY c.rowid DESC LIMIT 1',
      )
      .get(PLANTILLA);
    db.prepare(
      "UPDATE campaign_recipients SET wa_to=NULL, wa_recipient='MX.ui00000000beef' WHERE campaign_id=? AND contact_id='ui-dif-2'",
    ).run(id);
    db.prepare("UPDATE campaigns SET status='stopped', status_reason='number_listen_only' WHERE id=?").run(id);
  } finally {
    db.close();
  }
  const estado = page.locator('#page form[data-do="filtro"] select');
  await estado.selectOption('sent');
  await estado.selectOption('');
  const destinatarios = page.locator('#page [aria-label="Destinatarios"]');
  const sinNumero = destinatarios.locator('li', { hasText: 'Persona Difusión 2' });
  await expect(sinNumero).toContainText('Número oculto ··beef');
  await expect(sinNumero.locator('.dif-sin-numero')).toHaveText('Sin número');
  await expect(destinatarios).not.toContainText('MX.ui');
  await expect(page.locator('#page .dif-aviso')).toHaveText('El número volvió al modo escucha y ya no envía');
  await settled(page);
  await expectNiebla(page, 'difusiones-sin-numero', testInfo);
  await page.locator('#page [data-do="volver"]').click();
  await expect(page.locator('#page [data-slot="tabla"]')).toContainText(PLANTILLA);
  await expect(page.locator('#page [data-slot="tabla"] .dif-motivo').first()).toHaveText(
    'El número volvió al modo escucha y ya no envía',
  );

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
