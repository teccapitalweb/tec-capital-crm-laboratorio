import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Pantalla «Audiencias» (public/screens/audiencias, en vista previa): lista de audiencias con los prediseñados,
// crear un segmento con el constructor de condiciones y su conteo en vivo, ver sus miembros y salir limpio. Los
// contactos son inventados y se crean por la API.
const NOMBRES = ['Renata Audiencia Prueba', 'Mateo Audiencia Prueba'];

test.beforeEach(async ({ page, baseURL }) => {
  const headers = { Origin: baseURL };
  const found = await page.request.get('/api/contacts?brand=globalvet&q=audiencia', { headers });
  expect(found.ok(), await found.text()).toBe(true);
  if ((await found.json()).contacts.length >= NOMBRES.length) return;
  for (const [i, name] of NOMBRES.entries()) {
    const created = await page.request.post('/api/crm/contacts', {
      headers,
      data: { brandId: 'globalvet', name, phone: `+52 55 7654 32${10 + i}` },
    });
    expect(created.status(), await created.text()).toBe(201);
  }
});

test('Audiencias: prediseñados, crear un segmento con conteo en vivo y ver sus miembros', async ({
  page,
}, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="audiencias"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Audiencias');
  const tabla = page.locator('#page [data-slot="tabla"]');
  await expect(tabla).toContainText('Alumnos inscritos');
  // La marca de los contactos de la prueba.
  const marca = page.locator('#page form[data-do="marca"] select');
  if (await marca.count()) await marca.selectOption('globalvet');
  await expect(tabla).toContainText('Alumnos inscritos');
  await expect(tabla).toContainText('Prediseñado');
  await settled(page);
  await expectNiebla(page, 'audiencias', testInfo);

  // Nuevo segmento: una condición a medias no cuenta; completa, enseña cuántos entran.
  const nombre = `Con teléfono ${testInfo.project.name}`;
  await page.locator('#page [data-do="nuevo-segmento"]').click();
  const ventana = page.getByRole('dialog');
  await expect(ventana).toBeVisible();
  await expect(ventana.locator('.aud-resumen')).toContainText('pueden recibir');
  await ventana.locator('[data-do="k-cond-add-group"]').click();
  await expect(ventana.locator('[data-slot="vista"]')).toContainText('Completa la condición');
  await ventana.locator('[data-do="k-cond-field"]').first().selectOption('has_phone');
  await expect(ventana.locator('[data-slot="vista"]')).toContainText('Tiene teléfono');
  await expect(ventana.locator('.aud-resumen')).toContainText('pueden recibir');
  await expect(ventana.locator('.aud-motivos')).toContainText('Sin consentimiento para promociones');
  await settled(page, 'dialog.k-dialog');
  await expectNiebla(page, 'audiencias-segmento', testInfo);
  await ventana.locator('[name="name"]').fill(nombre);
  await ventana.getByRole('button', { name: 'Crear segmento' }).click();
  await expect(ventana).toHaveCount(0);
  await expect(tabla).toContainText(nombre);

  // Ver a sus miembros, con su estado.
  const fila = tabla.locator('tbody tr', { hasText: nombre });
  await fila.locator('[data-do="ver"]').click();
  const miembros = page.getByRole('dialog');
  await expect(miembros).toContainText('Renata Audiencia Prueba');
  await expect(miembros).toContainText('Sin consentimiento para promociones');
  await miembros.getByRole('button', { name: 'Cerrar' }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
