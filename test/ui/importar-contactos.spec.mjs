import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Importar contactos» (public/screens/importar-contactos, en vista previa): se abre desde el menú, sube un CSV con la
// forma de la exportación del proveedor anterior, elige columnas y declara el origen del permiso, revisa la vista
// previa con sus errores por fila, importa y ve el resultado. Cumple Niebla en cada paso y se desmonta al salir.
// Teléfonos y nombres inventados; cada tamaño usa los suyos para no chocar con el otro.
test('importar contactos: archivo, columnas, vista previa, importación y resultado', async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const watcher = watch(page);
  const base = testInfo.project.name === 'celular' ? 5560000000 : 5570000000;
  const csv = [
    'Name,CountryCode,Phone,Allow Campaign,Allow SMS',
    `Ana Prueba,52,${base + 1},TRUE,FALSE`,
    `José Núñez,52,${base + 2},FALSE,FALSE`,
    `Sin teléfono,52,no tengo,TRUE,FALSE`,
    `Ana repetida,52,${base + 1},TRUE,FALSE`,
  ].join('\n');

  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="importar-contactos"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Importar contactos');
  await expect(page.locator('#page .k-wizard')).toBeVisible();
  await settled(page);
  await expectNiebla(page, 'importar-contactos', testInfo);

  // Paso 1: sin archivo no se avanza; con archivo, se sube.
  const next = page.locator('#page [data-do="k-wz-next"]');
  await next.click();
  await expect(page.locator('#page .k-wizard .k-error')).toContainText('Elige el archivo');
  await page
    .locator('#page input[type="file"]')
    .setInputFiles({ name: 'exportacion.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await expect(page.locator('#page')).toContainText('Listo para subir: exportacion.csv');
  await next.click();

  // Paso 2: la sugerencia reconoce la exportación; se declara el origen del permiso.
  await expect(page.locator('#page .k-wizard__title')).toHaveText('Columnas y permiso');
  await expect(page.locator('#page')).toContainText('exportación del proveedor anterior');
  await expect(page.locator('#page [name="col-2"]')).toHaveValue('phone');
  await page.locator('#page [name="consentMode"][value="declared"]').check();
  await page.locator('#page [name="origin"]').fill('Aceptaron promociones al inscribirse en el formulario del curso.');
  await settled(page);
  await expectNiebla(page, 'importar-contactos', testInfo);
  await next.click();

  // Paso 3: la vista previa termina y enseña las filas con error.
  await expect(page.locator('#page .k-wizard__title')).toHaveText('Vista previa');
  await expect(page.locator('#page .k-tiles')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('#page [data-slot="filas"]')).toContainText('no tengo');
  await expect(page.locator('#page a[download]')).toHaveAttribute('href', /errors\.csv\?phase=preview$/);
  await settled(page);
  await expectNiebla(page, 'importar-contactos', testInfo);
  await next.click();

  // Paso 4: hay que confirmar la declaración antes de importar.
  await expect(page.locator('#page .k-wizard__title')).toHaveText('Importar');
  await next.click();
  await expect(page.locator('#page .k-wizard .k-error')).toContainText('confirmación');
  await page.locator('#page [name="confirmo"]').check();
  await next.click();
  await expect(page.locator('#page')).toContainText('Importación terminada', { timeout: 30_000 });
  await expect(page.locator('#page .k-tiles')).toBeVisible();
  await expect(page.locator('#page [data-slot="final"]')).toContainText('no tengo');
  await expect(page.locator('#page a[download]')).toHaveAttribute('href', /errors\.csv\?phase=apply$/);
  await settled(page);
  await expectNiebla(page, 'importar-contactos', testInfo);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
