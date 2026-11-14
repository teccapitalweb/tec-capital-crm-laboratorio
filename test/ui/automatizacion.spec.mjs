import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// La pantalla «Automatización» (en vista previa) monta el editor de recorridos con datos de ejemplo. En computadora
// abre en el lienzo; en celular, en el esquema, y la paleta es una hoja que se abre con «Agregar».
test('automatización: se monta desde el menú, cumple Niebla, agrega un paso, lo deshace y sale limpia', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="automatizacion"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Automatización');

  const editor = page.locator('#page .lz');
  await expect(editor).toBeVisible();
  await expect(page.locator('#page')).toContainText('Datos de ejemplo');
  await expect(editor).toHaveAttribute('data-layout', phone ? 'narrow' : 'wide');
  await expect(editor).toHaveAttribute('data-pane', phone ? 'outline' : 'canvas');
  // el recorrido de ejemplo: once pasos, sin problemas
  const steps = editor.locator('.lz-node');
  await expect(steps).toHaveCount(11);
  await expect(editor.locator('[data-slot="problemas"]')).toContainText('Sin problemas');
  await expect(phone ? editor.locator('.lz-row').first() : steps.first()).toBeVisible();
  await settled(page);
  await expectNiebla(page, 'automatizacion', testInfo);

  // agregar un paso desde la paleta…
  const undo = editor.locator('.lz-bar [data-do="deshacer"]');
  await expect(undo).toHaveAttribute('aria-disabled', 'true');
  if (phone) await editor.locator('.lz-bar [data-do="paleta"]').click();
  await editor.locator('[data-do="paleta-tipo"][data-type="message"]').click();
  await expect(steps).toHaveCount(12);
  await expect(undo).toHaveAttribute('aria-disabled', 'false');
  // …queda seleccionado, con sus ajustes en el panel y con el aviso de que le falta el texto
  await expect(editor.locator('.lz-panel-title')).toHaveText('Mensaje');
  await expect(editor.locator('[data-slot="problemas"]').first()).toContainText('1 error');

  // …y deshacerlo
  await undo.click();
  await expect(steps).toHaveCount(11);
  await expect(undo).toHaveAttribute('aria-disabled', 'true');
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toContainText('Sin problemas');

  // al salir no queda nada de la pantalla y la aplicación de siempre sigue funcionando
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .lz')).toHaveCount(0);
  await settled(page);
  await expect(page.locator('#page')).toContainText('Hola,');
  watcher.done();
});
