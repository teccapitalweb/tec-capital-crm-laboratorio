import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Datos de contacto» (public/screens/atributos, en vista previa): se abre desde el menú, crea un dato con la
// ventana del kit, lo muestra en la tabla, cumple Niebla y se desmonta al salir.
test('datos de contacto: crear un dato desde la ventana y verlo en la tabla', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="atributos"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Datos de contacto');
  await expect(page.locator('#page .k-page')).toBeVisible();
  await settled(page);

  // La ventana valida antes de enviar: sin nombre no se crea nada.
  const label = `Ciudad ${testInfo.project.name}`;
  await page.locator('#page [data-do="nuevo"]').click();
  const ventana = page.getByRole('dialog');
  await expect(ventana).toBeVisible();
  await ventana.getByRole('button', { name: 'Crear dato' }).click();
  await expect(ventana.locator('.k-error').first()).toBeVisible();
  await ventana.locator('[name="label"]').fill(label);
  await ventana.locator('[name="type"]').selectOption('text');
  await ventana.getByRole('button', { name: 'Crear dato' }).click();
  await expect(ventana).toHaveCount(0);
  await expect(page.locator('#page [data-slot="tabla"]')).toContainText(label);
  await expect(page.locator('#page [data-slot="tabla"]')).toContainText(`ciudad_${testInfo.project.name}`);
  await expect(page.locator('#page')).toContainText(/[1-9] de 60 datos activos/);
  await settled(page);
  await expectNiebla(page, 'atributos', testInfo);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
