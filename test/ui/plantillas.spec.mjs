import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Plantillas de WhatsApp» (public/screens/plantillas, en vista previa): se abre desde el menú, avisa que falta la
// cuenta de Meta, crea un borrador con encabezado, datos y botón viendo la vista previa en forma de mensaje, lo
// muestra en la tabla, cumple Niebla y se desmonta al salir. Sin Meta: nada sale a la red.
test('plantillas: escribir un borrador con vista previa y verlo en la lista', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="plantillas"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Plantillas de WhatsApp');
  await expect(page.locator('#page .k-page')).toBeVisible();
  await settled(page);
  await expect(page.locator('#page')).toContainText('Sin cuenta de WhatsApp Business');

  // el editor: la vista previa sigue lo que se escribe; el servidor valida al guardar
  const name = `aviso_ui_${testInfo.project.name}`;
  await page.locator('#page [data-do="nueva"]').click();
  const ventana = page.getByRole('dialog');
  await expect(ventana).toBeVisible();
  await ventana.locator('[name="name"]').fill(name);
  await ventana.locator('[name="body"]').fill('Hola');
  await ventana.getByRole('button', { name: 'Crear borrador' }).click();
  await expect(ventana.locator('.k-notice--bad')).toContainText('al menos 10 caracteres');
  await ventana.locator('[name="headerType"]').selectOption('text');
  await ventana.locator('[name="headerText"]').fill('Novedades de {{curso}}');
  await ventana
    .locator('[name="body"]')
    .fill('Hola {{nombre}}, abrimos inscripciones. Responde a este mensaje para apartar tu lugar.');
  await ventana.getByRole('button', { name: 'Añadir botón' }).click();
  await ventana.locator('[name="b0:text"]').fill('Me interesa');
  const vista = ventana.locator('.pla-vista');
  await expect(vista).toContainText('Novedades de Plan sanitario para aves');
  await expect(vista).toContainText('Hola María, abrimos inscripciones.');
  await expect(vista.locator('.pla-boton')).toHaveText('Me interesa');
  await ventana.getByRole('button', { name: 'Crear borrador' }).click();
  await expect(ventana).toHaveCount(0);
  await expect(page.locator('#page [data-slot="tabla"]')).toContainText(name);
  await expect(page.locator('#page [data-slot="tabla"]')).toContainText('Borrador');
  await settled(page);
  await expectNiebla(page, 'plantillas', testInfo);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
