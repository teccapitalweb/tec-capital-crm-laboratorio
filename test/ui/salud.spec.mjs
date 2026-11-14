import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Salud de WhatsApp» (public/screens/salud, en vista previa): se abre desde el menú, dice con claridad que WhatsApp
// real no está conectado (el servidor de las pruebas usa el canal simulado), no ofrece consultar a Meta, cumple
// Niebla y se desmonta al salir. Sin Meta: nada sale a la red.
test('salud: sin WhatsApp real lo dice y no falla', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="salud"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Salud de WhatsApp');
  await expect(page.locator('#page .k-page')).toBeVisible();
  await settled(page);
  await expect(page.locator('#page')).toContainText('WhatsApp real no está conectado');
  await expect(page.locator('#page [data-do="consultar"]')).toBeDisabled();
  await expect(page.locator('#page')).toContainText('Historial de avisos');
  await expectNiebla(page, 'salud', testInfo);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
