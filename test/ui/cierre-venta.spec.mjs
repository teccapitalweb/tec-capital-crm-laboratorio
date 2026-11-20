import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminContext, expectNiebla, settled, watch } from './helpers.mjs';

// Cierre de la venta en el chat (docs/PLAN_CIERRE_DE_VENTA.md): con un comprobante por revisar, el chat del equipo
// muestra una franja con «Ver comprobante», «Validar pago» y «No es válido»; al validar, la franja pasa a decir que el
// pago quedó confirmado y qué pasa con los accesos. En computadora y en celular, sin errores y cumpliendo las reglas.
const PNG = Buffer.from([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137,
]).toString('base64');

test('chat: comprobante por revisar, validar el pago y estado de los accesos', async ({ browser }, testInfo) => {
  const base = testInfo.project.use.baseURL;
  const headers = { Origin: base };
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Cierre ${testInfo.project.name === 'celular' ? 'C' : 'E'} ${tag.slice(-4)}`;

  const teamContext = await adminContext(browser);
  const team = teamContext.request;
  // la venta con pago nace apagada por marca: se enciende si hace falta (otra prueba pudo dejarla encendida)
  const { settings } = await (await team.get('/api/payments/settings')).json();
  const gv = settings.find(s => s.brand_id === 'globalvet');
  if (!gv.enabled)
    await team.patch('/api/payments/brands/globalvet', {
      headers,
      data: { enabled: true, linkHours: 48, expectedRevision: gv.revision },
    });

  // una persona con su pedido y su comprobante enviado por el chat
  const customerContext = await browser.newContext();
  const customer = customerContext.request;
  await customer.post('/api/auth/register', {
    headers,
    data: { username: `cliente.cierre.${tag}`, name, password: 'Password-cliente-2026!' },
  });
  const { conversation } = await (
    await customer.post('/api/conversations', { headers, data: { courseId: 'aves', channel: 'whatsapp' } })
  ).json();
  const made = await team.post(`/api/conversations/${conversation.id}/orders`, { headers, data: {} });
  expect(made.status(), await made.text()).toBe(201);
  const { order } = await made.json();
  const sent = await customer.post(`/api/conversations/${conversation.id}/messages`, {
    headers,
    data: {
      text: '',
      clientRef: randomUUID(),
      attachment: { name: 'comprobante.png', type: 'image/png', base64: PNG },
    },
  });
  expect(sent.status(), await sent.text()).toBe(201);

  const page = await teamContext.newPage();
  const watcher = watch(page);
  await page.goto('/crm');
  await page.locator('.nav [data-view="inbox"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Conversaciones');
  await page.locator(`.thread[data-conversation="${conversation.id}"]`).click();

  // la franja: qué pedido es, y las tres acciones
  const strip = page.locator('#conv-sale .sale-strip');
  await expect(strip).toContainText('Comprobante por revisar');
  await expect(strip).toContainText(order.reference);
  await expect(strip.locator('a', { hasText: 'Ver comprobante' })).toHaveAttribute('href', /^\/api\/files\//);
  await expect(strip.locator('[data-action="sale-accept"]')).toBeVisible();

  // «No es válido» pide el motivo antes de avisar, y se puede cancelar sin cambiar nada
  await strip.locator('[data-action="sale-reject"]').click();
  await expect(page.locator('#sale-reason')).toBeVisible();
  await settled(page, '#conv-sale');
  // misma vista que «inbox-chat» y misma línea base: la franja no puede añadir ni un fallo a los que ya había
  await expectNiebla(page, 'inbox-chat', testInfo);
  await page.locator('[data-action="sale-reject-close"]').click();
  await expect(page.locator('#sale-reason')).toHaveCount(0);

  // validar: pide confirmación; la franja pasa a pago confirmado y dice qué pasa con los accesos
  page.once('dialog', dialog => {
    expect(dialog.message()).toContain(order.reference);
    dialog.accept();
  });
  await page.locator('#conv-sale [data-action="sale-accept"]').click();
  await expect(page.locator('#conv-sale .sale-strip')).toContainText('Pago confirmado');
  await expect(page.locator('#conv-sale .sale-strip')).toContainText(/accesos/);
  await expect(page.locator('#conv-sale [data-action="sale-accept"]')).toHaveCount(0);
  await expect(page.locator('#history')).toContainText('Pago confirmado');
  await settled(page, '#conv-sale');
  await expectNiebla(page, 'inbox-chat', testInfo);
  watcher.done();
  await customerContext.close();
  await teamContext.close();
});
