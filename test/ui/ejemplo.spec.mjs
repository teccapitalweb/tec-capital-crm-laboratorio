import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// La pantalla de ejemplo del kit (public/screens/ejemplo, en vista previa) comprueba el camino completo de una
// pantalla nueva: lista del servidor → menú → montaje dentro de #page → reglas de Niebla → salida limpia.
test('una pantalla nueva se monta desde el menú, cumple Niebla y se desmonta al salir', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="ejemplo"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Ejemplo del kit');
  await expect(page.locator('#page .k-page')).toBeVisible();
  await settled(page);
  await expectNiebla(page, 'ejemplo', testInfo);

  // al salir no queda nada de la pantalla y la aplicación de siempre sigue funcionando
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  await settled(page);
  await expect(page.locator('#page')).toContainText('Hola,');
  watcher.done();
});
