import { test, expect } from '@playwright/test';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Pantalla «Contactos» (public/screens/contactos, en vista previa): lista paginada de /api/contacts, búsqueda,
// panel del contacto y lo que sobrevive a un remontaje. Los contactos son inventados y se crean por la API.
const NOMBRES = ['Fernanda Zúñiga Prueba', 'Óscar Ruiz Prueba', 'Lucía Díaz Prueba'];

test.beforeEach(async ({ page, baseURL }) => {
  const headers = { Origin: baseURL };
  const found = await page.request.get('/api/contacts?brand=globalvet&q=prueba', { headers });
  expect(found.ok(), await found.text()).toBe(true);
  if ((await found.json()).contacts.length >= NOMBRES.length) return;
  for (const [i, name] of NOMBRES.entries()) {
    const created = await page.request.post('/api/crm/contacts', {
      headers,
      data: { brandId: 'globalvet', name, phone: `+52 55 4321 98${10 + i}`, email: `persona${i}@correo.mx` },
    });
    expect(created.status(), await created.text()).toBe(201);
  }
});

test('Contactos se monta desde el menú, busca, abre el panel, cumple Niebla y recuerda la búsqueda', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="contactos"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Contactos');
  await expect(page.locator('#page .k-table__grid tbody tr').first()).toBeVisible();
  await expect(page.locator('#page [data-slot="total"]')).toContainText('contacto');
  await settled(page);
  await expectNiebla(page, 'contactos', testInfo);

  // buscar sin acentos ni mayúsculas
  await page.locator('#page [data-do="buscar"]').fill('ZUNIGA');
  const rows = page.locator('#page .k-table__grid tbody tr');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('Fernanda Zúñiga Prueba');
  await expect(page.locator('#page [data-slot="total"]')).toContainText('1 contacto');

  // un filtro rápido se puede activar y quitar
  const chip = page.locator('#page [data-do="rapido"][data-id="opted_in"]');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#page .k-state')).toContainText('Ningún contacto coincide');
  await chip.click();
  await expect(rows).toHaveCount(1);

  // el panel del contacto
  await rows.first().locator('[data-do="k-open"]').click();
  const panel = page.locator('#page .k-side[open]');
  await expect(panel.locator('.k-side__title')).toHaveText('Fernanda Zúñiga Prueba');
  await expect(panel).toContainText('Consentimiento');
  await expect(panel).toContainText('Todavía no tiene intereses.');
  await settled(page);
  await expectNiebla(page, 'contactos-panel', testInfo);
  await page.keyboard.press('Escape');
  await expect(page.locator('#page .k-side[open]')).toHaveCount(0);

  // salir y volver: la búsqueda sigue ahí (ctx.keep) y la aplicación de siempre funciona
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .ct-page')).toHaveCount(0);
  await settled(page);
  await page.locator('.nav [data-view="contactos"]').click();
  await expect(page.locator('#page [data-do="buscar"]')).toHaveValue('ZUNIGA');
  await expect(rows).toHaveCount(1);
  await settled(page);
  watcher.done();
});

// Un nombre muy largo ensancha la tabla más que su caja. La tabla se desplaza dentro de la caja, pero los rótulos
// ocultos (.k-sr, absolutos) de las cabeceras se escapaban del recorte y ensanchaban el documento 2 o 3 px a 1366 px:
// fallaba de vez en cuando la medida de desbordamiento. Se comprueba la causa (cada .k-sr cuelga de una caja del kit)
// además del efecto.
const LARGO = 'Maximiliana Guadalupe de los Ángeles Fernández-Castellanos Larguísimo Prueba';
test('Contactos: un nombre larguísimo no ensancha la página', async ({ page, baseURL }) => {
  const headers = { Origin: baseURL };
  const found = await page.request.get('/api/contacts?brand=globalvet&q=larguisimo', { headers });
  if (!(await found.json()).contacts.length) {
    const created = await page.request.post('/api/crm/contacts', {
      headers,
      data: { brandId: 'globalvet', name: LARGO, phone: '+52 55 4321 9899', email: 'larguisimo@correo.mx' },
    });
    expect(created.status(), await created.text()).toBe(201);
  }
  const watcher = watch(page);
  await page.goto('/crm');
  await page.locator('.nav [data-view="contactos"]').click();
  await page.locator('#page [data-do="buscar"]').fill('larguisimo');
  await expect(page.locator('#page .k-table__grid tbody tr')).toHaveCount(1);
  await settled(page);
  const medida = await page.evaluate(() => ({
    sobra: document.documentElement.scrollWidth - window.innerWidth,
    sueltos: [...document.querySelectorAll('#page .k-sr')]
      .filter(el => el.getClientRects().length)
      .filter(el => !el.offsetParent?.closest('.k-page')).length,
  }));
  expect(medida).toEqual({ sobra: 0, sueltos: 0 });
  watcher.done();
});

// Alguien que conversa por WhatsApp real sólo con su identificador de usuario (sin teléfono visible). Se escribe en la
// base de la prueba: un cliente, su contacto, una conversación con número real y su identificador (inventado).
const SIN_NUMERO = 'Julián Sin Número Prueba';
function sembrarSinNumero() {
  const db = new DatabaseSync(join(process.env.CRM_UI_DATA_DIR, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    if (db.prepare('SELECT 1 FROM contacts WHERE id=?').get('ui-sin-numero')) return;
    const t = Date.now();
    db.prepare(
      "INSERT INTO users(id,username,name,password_hash,role,test_number,created_at,last_seen) VALUES('ui-cli-wa','ui.cliente.wa',?,'x','customer',990777,?,?)",
    ).run(SIN_NUMERO, t, t);
    db.prepare(
      "INSERT INTO contacts(id,brand_id,name,phone,phone_key,source,source_user_id,created_at,updated_at) VALUES('ui-sin-numero','globalvet',?,'','','whatsapp','ui-cli-wa',?,?)",
    ).run(SIN_NUMERO, t, t);
    db.prepare(
      "INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,status,created_at,updated_at,wa_number) VALUES('ui-cv-wa','ui-cli-wa','globalvet','aves','whatsapp','resolved',?,?,'ui-numero')",
    ).run(t, t);
    db.prepare(
      "INSERT INTO identity_keys(kind,scope,value,user_id,username,source,first_seen,last_seen) VALUES('wa_bsuid','waba:ui','MX.ui0000000000c0de','ui-cli-wa','julian.prueba','webhook',?,?)",
    ).run(t, t);
  } finally {
    db.close();
  }
}

test('Contactos: «Sin teléfono», distintivo «sin número», bloque WhatsApp y añadir a una lista', async ({
  page,
  baseURL,
}, testInfo) => {
  sembrarSinNumero();
  const watcher = watch(page);
  await page.goto('/crm');
  await page.locator('.nav [data-view="contactos"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Contactos');
  const buscar = page.locator('#page [data-do="buscar"]');
  const rows = page.locator('#page .k-table__grid tbody tr');

  // Filtro «Sin teléfono» y el distintivo «sin número» (nunca el identificador).
  await buscar.fill('sin numero prueba');
  const chip = page.locator('#page [data-do="rapido"][data-id="no_phone"]');
  await chip.click();
  await expect(chip).toHaveAttribute('aria-pressed', 'true');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText(SIN_NUMERO);
  await expect(rows.first().locator('.ct-sin-numero')).toHaveText('Sin número');
  await expect(page.locator('#page')).not.toContainText('c0de');
  await settled(page);
  await expectNiebla(page, 'contactos-sin-telefono', testInfo);

  // El bloque «WhatsApp» del panel, con el identificador abreviado.
  await rows.first().locator('[data-do="k-open"]').click();
  const panel = page.locator('#page .k-side[open]');
  const bloque = panel.locator('[data-key="ct-whatsapp"]');
  await expect(bloque).toContainText('WhatsApp');
  await expect(bloque).toContainText('@julian.prueba');
  await expect(bloque).toContainText('··c0de');
  await expect(bloque).toContainText('Sí, conversa por WhatsApp real');
  await expect(bloque).not.toContainText('MX.ui');
  await settled(page);
  await expectNiebla(page, 'contactos-whatsapp', testInfo);
  await page.keyboard.press('Escape');
  await expect(page.locator('#page .k-side[open]')).toHaveCount(0);

  // Añadir a una lista nueva dos contactos elegidos; repetirlo en la misma lista no duplica.
  await chip.click();
  await buscar.fill('prueba');
  await expect(rows.first()).toBeVisible();
  const elegir = nombre => page.locator(`#page input[data-do="k-row"][aria-label="Seleccionar ${nombre}"]`).check();
  await elegir('Fernanda Zúñiga Prueba');
  await elegir(SIN_NUMERO);
  await page.locator('#page [data-do="anadir-lista"]').click();
  const ventana = page.getByRole('dialog');
  await expect(ventana).toContainText('2 contactos elegidos.');
  const nombre = `Lista desde contactos ${testInfo.project.name}`;
  await ventana.locator('[name="name"]').fill(nombre);
  await settled(page, 'dialog.k-dialog');
  await expectNiebla(page, 'contactos-lista', testInfo);
  await ventana.getByRole('button', { name: 'Añadir' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#page input[data-do="k-row"]:checked')).toHaveCount(0);

  const headers = { Origin: baseURL };
  const listaCreada = async () => {
    const r = await page.request.get('/api/audiences?brand=globalvet', { headers });
    expect(r.ok()).toBe(true);
    return (await r.json()).audiences.find(a => a.name === nombre);
  };
  expect((await listaCreada()).memberCount).toBe(2);

  await elegir('Fernanda Zúñiga Prueba');
  await page.locator('#page [data-do="anadir-lista"]').click();
  await page
    .getByRole('dialog')
    .locator('[name="destino"]')
    .selectOption({ label: `${nombre} · 2` });
  await expect(page.getByRole('dialog').locator('[name="name"]')).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Añadir' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await listaCreada()).memberCount).toBe(2);
  watcher.done();
});
