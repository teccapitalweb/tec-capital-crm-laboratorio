import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Accesos del curso» (public/screens/accesos): se abre desde el menú, elige GlobalVet, abre una apertura sin accesos,
// usa el texto sugerido, ve en «Antes de encender» el «(pega aquí…)» pendiente, lo cambia por enlaces de ejemplo, ve la
// vista previa ya armada, enciende el envío, guarda y la apertura queda «Se envía solo». Los dos tamaños comparten la
// base de datos: si ya no queda ninguna apertura sin accesos (otra corrida la escribió), se reescribe la primera.
// No se confirma ningún pago: no sale ningún mensaje.
test('accesos: escribir los accesos de una apertura y encender el envío', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="accesos"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Accesos del curso');
  await expect(page.locator('#page .k-page')).toBeVisible();
  await settled(page);

  const marca = page.locator('#page form[data-do="marca"] select');
  if (await marca.count()) {
    await marca.selectOption('globalvet');
    await settled(page);
  }
  const tarjetas = page.locator('#page .acc-apertura');
  await expect(tarjetas.first()).toBeVisible();
  await expect(page.locator('#page')).toContainText('Últimas entregas');
  await expectNiebla(page, 'accesos', testInfo);

  const sinAccesos = tarjetas.filter({ hasText: 'Sin accesos' });
  const hay = await sinAccesos.count();
  if (hay) await expect(sinAccesos.first()).toContainText('Escribir accesos');
  const tarjeta = hay ? sinAccesos.first() : tarjetas.first();
  const id = await tarjeta.getAttribute('data-id');
  await tarjeta.locator('[data-do="editar"]').click();

  const editor = page.locator('#page form[data-do="editor"]');
  await expect(editor).toBeVisible();
  await expect(page.locator('#page .k-back')).toHaveText('Accesos');
  const texto = editor.locator('textarea[name="body"]');
  if ((await texto.inputValue()).trim()) await texto.fill('');
  await editor.locator('[data-do="sugerido"]').click();
  await expect(texto).toHaveValue(/pega aquí/);

  const faltan = editor.locator('.acc-faltan');
  await expect(faltan).toContainText('Antes de encender');
  await expect(faltan).toContainText('(pega aquí…)');

  const sugerido = await texto.inputValue();
  await texto.fill(
    sugerido
      .replace('(pega aquí el enlace)', 'https://clases.ejemplo.mx/aves')
      .replace('(pega aquí el enlace)', 'https://material.ejemplo.mx/aves'),
  );
  await expect(faltan).toHaveCount(0);
  const burbuja = editor.locator('.acc-burbuja');
  await expect(burbuja).toContainText('https://clases.ejemplo.mx/aves');
  await expect(burbuja).toContainText('Ana');
  await expect(burbuja).not.toContainText('{{');

  // Un dato se pone donde está el cursor.
  await texto.press('End');
  await editor.locator('[data-do="dato"][data-id="marca"]').click();
  await expect(texto).toHaveValue(/\{\{marca\}\}$/);
  await expect(burbuja).not.toContainText('{{');

  await editor.locator('input[name="enabled"]').check();
  await settled(page);
  await expectNiebla(page, 'accesos-editor', testInfo);
  await editor.getByRole('button', { name: 'Guardar' }).click();
  await expect(editor).toHaveCount(0);

  const guardada = page.locator(`#page .acc-apertura[data-id="${id}"]`);
  await expect(guardada).toContainText('Se envía solo');
  await expect(guardada.locator('[data-do="editar"]')).toHaveText('Editar');
  await settled(page);
  await expectNiebla(page, 'accesos', testInfo);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
