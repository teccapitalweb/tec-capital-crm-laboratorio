import { test, expect } from '@playwright/test';
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
