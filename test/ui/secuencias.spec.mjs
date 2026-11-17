import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Secuencias de seguimiento» (public/screens/secuencias, en vista previa): se abre desde el menú, avisa que la marca
// no envía nada mientras su automatización esté apagada, crea una secuencia con el editor de pasos (un paso
// relativo a la inscripción y otro relativo al inicio del curso), la muestra apagada, abre la vista previa y los
// resultados, cumple Niebla y se desmonta al salir. No se enciende nada: no sale ningún mensaje.
test('secuencias: crear una secuencia de dos pasos, vista previa y resultados', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="secuencias"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Secuencias de seguimiento');
  await expect(page.locator('#page .k-page')).toBeVisible();
  await settled(page);

  await page.locator('#page [data-do="nueva"]').click();
  const editor = page.locator('#page form[data-do="editor"]');
  await expect(editor).toBeVisible();
  // Sin nombre ni mensaje, el servidor explica qué falta y no guarda.
  await editor.getByRole('button', { name: 'Guardar' }).click();
  await expect(page.locator('#page [role="alert"]')).toContainText('nombre');

  const title = `Seguimiento ${testInfo.project.name}`;
  await editor.locator('[name="title"]').fill(title);
  await editor.locator('[name="text-0"]').fill('Hola {{nombre}}, ¿pudiste revisar la ficha del curso?');
  await editor.locator('[data-do="agregar"]').click();
  await editor.locator('[name="base-1"]').selectOption('edition_start');
  await expect(editor.locator('[name="daysBefore-1"]')).toBeVisible();
  await editor.locator('[name="daysBefore-1"]').fill('2');
  await editor.locator('[name="text-1"]').fill('Faltan dos días para empezar.');
  // Lo escrito en el primer paso sobrevive al repintado del segundo.
  await expect(editor.locator('[name="title"]')).toHaveValue(title);
  await settled(page);
  await expectNiebla(page, 'secuencias', testInfo);
  await editor.getByRole('button', { name: 'Guardar' }).click();
  await expect(editor).toHaveCount(0);

  const card = page.locator('#page .sq-tarjeta', { hasText: title });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Apagada');
  await expect(card).toContainText('1 día después de inscribirse');
  await expect(card).toContainText('2 días antes del inicio, 10:00');

  await card.locator('[data-do="previa"]').click();
  const ventana = page.getByRole('dialog');
  await expect(ventana).toContainText('Nada de esto se envía');
  await ventana.getByRole('button', { name: 'Cerrar' }).last().click();
  await expect(ventana).toHaveCount(0);
  await card.locator('[data-do="resultados"]').click();
  await expect(page.getByRole('dialog')).toContainText('Resultados por paso');
  await page.getByRole('dialog').getByRole('button', { name: 'Cerrar' }).last().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await settled(page);
  await expectNiebla(page, 'secuencias', testInfo);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
