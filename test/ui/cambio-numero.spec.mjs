import { test, expect } from '@playwright/test';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Cambio de número» (public/screens/cambio-numero, en vista previa): un número de prueba (identificador inventado)
// en el servidor de las pruebas, que usa el canal simulado. Volver a escucha y pasar a activo con la confirmación
// escrita, la vista previa de «Abrir conversaciones recientes», registrar con un PIN de prueba (simulado: no se llama
// a nadie), Niebla en los dos tamaños y salir limpio.
const NUMERO = '109000000000777';

test.beforeEach(async ({ page, baseURL }) => {
  const headers = { Origin: baseURL };
  const status = await (await page.request.get('/api/whatsapp', { headers })).json();
  const current = status.numbers.find(n => n.phoneNumberId === NUMERO);
  if (!current) {
    const created = await page.request.put('/api/whatsapp/numbers/' + NUMERO, {
      headers,
      data: { brandId: 'globalvet', label: 'Número de ensayo', expectedRevision: 0 },
    });
    expect(created.ok(), await created.text()).toBe(true);
  } else if (current.mode !== 'live') {
    const changed = await page.request.post(`/api/whatsapp/numbers/${NUMERO}/mode`, {
      headers,
      data: { mode: 'live', expectedRevision: current.revision },
    });
    expect(changed.ok(), await changed.text()).toBe(true);
  }
});

test('Cambio de número: escucha, activo, recientes y registro con confirmación escrita', async ({ page }, testInfo) => {
  const watcher = watch(page);
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const entry = page.locator('.nav [data-view="cambio-numero"]');
  await expect(entry).toBeVisible();
  await entry.click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Cambio de número');
  const card = page.locator(`#page .cn-numero[data-key="${NUMERO}"]`);
  await expect(card).toContainText('Activo');
  await expect(page.locator('#page')).toContainText('WhatsApp real no está conectado');

  // volver a escucha: la palabra equivocada no basta
  await card.locator('[data-do="escuchar"]').click();
  const ventana = page.locator('dialog.k-dialog');
  await expect(ventana).toContainText('Es la vuelta atrás');
  await ventana.locator('input[name="palabra"]').fill('escuch');
  await ventana.locator('button[type="submit"]').click();
  await expect(ventana).toContainText('Escribe ESCUCHA tal cual');
  await ventana.locator('input[name="palabra"]').fill('escucha');
  await ventana.locator('button[type="submit"]').click();
  await expect(ventana).toHaveCount(0);
  await expect(card).toContainText('En escucha');
  await expect(card.locator('[data-do="activar"]')).toBeVisible();
  await settled(page);
  await expectNiebla(page, 'cambio-numero', testInfo);
  // pasar a activo
  await card.locator('[data-do="activar"]').click();
  await ventana.locator('input[name="palabra"]').fill('ACTIVAR');
  await ventana.locator('button[type="submit"]').click();
  await expect(card.locator('[data-do="recientes"]')).toBeVisible();
  await expect(card).toContainText('Pasó a activo');

  // abrir recientes: la vista previa dice cuántas y se puede cancelar
  await card.locator('[data-do="recientes"]').click();
  await expect(ventana).toContainText('Se abrirán 0 conversaciones');
  await ventana.locator('[data-do="cancelar"]').click();
  await expect(ventana).toHaveCount(0);

  // registrar: con el PIN de prueba, simulado
  await card.locator('[data-do="registrar"]').click();
  await ventana.locator('input[name="pin"]').fill('123');
  await ventana.locator('input[name="palabra"]').fill('REGISTRAR');
  await ventana.locator('button[type="submit"]').click();
  await expect(ventana).toContainText('El PIN son seis dígitos');
  await ventana.locator('input[name="pin"]').fill('000111');
  await ventana.locator('button[type="submit"]').click();
  await expect(ventana).toHaveCount(0);
  await expect(card).toContainText('Número registrado en Meta');

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
