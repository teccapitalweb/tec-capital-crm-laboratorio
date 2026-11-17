import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Reglas por mensaje» (public/screens/reglas, en vista previa): se abre desde el menú, crea dos reglas con el editor,
// las reordena con «Bajar», enciende una, la prueba con un mensaje sin enviar nada, muestra el orden de atención y
// cumple Niebla en la pantalla y en el editor.
test('reglas: crear, ordenar, encender y probar', async ({ page }, testInfo) => {
  const watcher = watch(page);
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  await page.goto('/crm');
  const entry = page.locator('.nav [data-view="reglas"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Reglas por mensaje');
  await expect(page.locator('#page .rg-pasos > li')).toHaveCount(5);
  await settled(page);

  async function crear(titulo, palabra, texto) {
    await page.locator('#page [data-do="nueva"]').click();
    const ventana = page.getByRole('dialog');
    await expect(ventana).toBeVisible();
    await ventana.locator('[name="title"]').fill(titulo);
    await ventana.locator('[name="words"]').fill(palabra);
    await ventana.locator('[name="a0_text"]').fill(texto);
    return ventana;
  }

  // Primera regla: el editor avisa de un importe tecleado y se corrige.
  const primera = `Precio ${tag}`;
  let ventana = await crear(primera, `precio${tag}`, 'Cuesta $1,500');
  await expectNiebla(page, 'reglas-editor', testInfo);
  await ventana.getByRole('button', { name: 'Guardar' }).click();
  await expect(ventana.locator('.k-notice--bad')).toContainText('importe escrito a mano');
  await ventana.locator('[name="a0_text"]').fill('Hola, {{nombre}}. El precio vigente es {{precio}}.');
  // Probar dentro del editor no guarda nada.
  await ventana.locator('[name="ensayo"]').fill(`¿Cuál es el precio${tag}?`);
  await ventana.getByRole('button', { name: 'Probar', exact: true }).click();
  await expect(ventana.locator('[data-ensayo]')).toContainText('Coincide');
  await ventana.getByRole('button', { name: 'Guardar' }).click();
  await expect(ventana).toHaveCount(0);

  const segunda = `Horario ${tag}`;
  ventana = await crear(segunda, `horario${tag}`, 'Atendemos de lunes a viernes.');
  await ventana.getByRole('button', { name: 'Guardar' }).click();
  await expect(ventana).toHaveCount(0);

  // Una regla nueva entra arriba; «Bajar» la pone debajo de la otra.
  const titulos = page.locator('#page .rg-lista .rg-regla__titulo strong');
  const orden = async () => (await titulos.allTextContents()).filter(t => t === primera || t === segunda);
  await expect.poll(orden).toEqual([segunda, primera]);
  await page.getByRole('button', { name: `Bajar «${segunda}»` }).click();
  await expect.poll(orden).toEqual([primera, segunda]);

  // Encender la primera.
  const fila = page.locator('#page .rg-regla', { hasText: primera });
  await fila.getByRole('button', { name: 'Encender' }).click();
  await expect(fila.locator('.k-chip').first()).toHaveText('Encendida');

  // Probar con un mensaje: dice quién contestaría y qué haría cada regla.
  const probar = page.locator('#page form[data-do="probar"]');
  await probar.locator('[name="text"]').fill(`precio${tag}`);
  await probar.getByRole('button', { name: 'Probar' }).click();
  const resultado = page.locator('#page .rg-resultado');
  await expect(resultado).toContainText('Contestaría:');
  await expect(resultado).toContainText(primera);
  await settled(page);
  await expectNiebla(page, 'reglas', testInfo);

  // Salir de la pantalla la desmonta.
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#page .rg-page')).toHaveCount(0);
  watcher.done();
});
