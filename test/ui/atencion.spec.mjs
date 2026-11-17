import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { AUTH, adminContext, expectNiebla, settled, watch } from './helpers.mjs';

// Tinta por dentro de Mi día y Conversaciones (docs/DISENO_Y_AUDITORIA.md): el rediseño cambia el aspecto, no las
// opciones. Aquí se comprueba que cada filtro, botón de estado y herramienta del chat sigue en su sitio y se ve, en
// computadora y en celular, y que los bloques de color usan la paleta de Tinta.
const INK = 'rgb(22, 24, 29)';
const LIME = 'rgb(217, 242, 79)';

test.describe('Mi día', () => {
  test.use({ storageState: AUTH.admin });

  test('las cuatro cifras son bloques de color y «Por atender» es el bloque en tinta', async ({ page }, testInfo) => {
    const watcher = watch(page);
    await page.goto('/crm');
    await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
    await settled(page);
    const stats = page.locator('.day-summary .day-stat');
    await expect(stats).toHaveCount(4);
    for (const label of ['Seguimientos para hoy', 'Esperando un asesor', 'Intereses sin asignar', 'Sin próxima tarea'])
      await expect(page.locator('.day-summary')).toContainText(label);
    await expect(stats.first()).toHaveCSS('border-top-left-radius', '28px');
    const figure = stats.first().locator('strong');
    await expect(figure).toHaveCSS('font-size', testInfo.project.name === 'celular' ? '44px' : '56px');
    await expect(page.locator('.day-attend')).toHaveCSS('background-color', INK);
    await expect(page.locator('.day-agenda h2')).toHaveText('Tu agenda de hoy');
    await expect(page.locator('.day-agenda [data-view="tasks"]')).toBeVisible();
    await expect(page.locator('.day-attend [data-view="inbox"]')).toBeVisible();
    await expectNiebla(page, 'day', testInfo);
    watcher.done();
  });
});

test('Conversaciones: filtros, estado y herramientas del chat siguen todos a la vista', async ({
  browser,
}, testInfo) => {
  const base = testInfo.project.use.baseURL;
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Cliente atencion ${tag}`;
  const customerContext = await browser.newContext();
  const customer = customerContext.request;
  const headers = { Origin: base };
  await customer.post('/api/auth/register', {
    headers,
    data: { username: `cliente.atencion.${tag}`, name, password: 'Password-cliente-2026!' },
  });
  const { conversation } = await (
    await customer.post('/api/conversations', { headers, data: { courseId: 'aves', channel: 'whatsapp' } })
  ).json();
  await customer.post(`/api/conversations/${conversation.id}/messages`, {
    headers,
    data: { text: 'Hola, quiero informes', clientRef: randomUUID() },
  });

  const teamContext = await adminContext(browser);
  const page = await teamContext.newPage();
  const watcher = watch(page);
  await page.goto('/crm');
  await page.locator('.nav [data-view="inbox"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Conversaciones');

  // Pestañas de canal en píldora, con su contador; la activa en tinta.
  for (const id of ['all', 'whatsapp', 'instagram', 'facebook'])
    await expect(page.locator(`.source-tab[data-source="${id}"] .source-count`)).toBeVisible();
  await expect(page.locator('.source-tab.active')).toHaveCSS('background-color', INK);
  // Lista: buscador, los cuatro filtros y el de etiquetas.
  await expect(page.locator('#thread-search')).toBeVisible();
  for (const id of ['all', 'waiting', 'mine', 'resolved'])
    await expect(page.locator(`.list-head [data-filter="${id}"]`)).toBeVisible();

  const thread = page.locator('.thread', { hasText: name });
  await thread.click();
  await expect(page.locator('#history .message')).not.toHaveCount(1);
  if (testInfo.project.name === 'escritorio') await expect(thread).toHaveCSS('background-color', LIME);

  // Cabecera, interés y etapa, y estado de la conversación.
  await expect(page.locator('.chat-head [data-action="search-messages"]')).toBeVisible();
  await expect(page.locator('.chat-head [data-action="contact-details"]')).toBeVisible();
  await expect(page.locator('#stage-picker')).toBeVisible();
  await expect(page.locator('.lc-bar .lc-chip')).toHaveText('Abierta');
  await expect(page.locator('.lc-bar [data-lc-to="pending"]')).toBeVisible();
  await expect(page.locator('.lc-bar [data-lc-to="solved"]')).toBeVisible();
  // Quién atiende y las diez herramientas (en celular, la fila se desliza: cada una se alcanza).
  await expect(page.locator('.assist-actions [data-chat-action]')).toBeVisible();
  const tools = [
    '[data-action="ops-detail"]',
    '[data-action="tg-open"]',
    '[data-action="qr-open"]',
    '[data-action="qr-remind"]',
    '[data-action="cat-materials"]',
    '[data-template="flyer"]',
    '[data-action="crm-insert-signature"]',
    '[data-template="syllabus"]',
    '[data-template="price"]',
    '[data-action="pay-new"]',
  ];
  for (const selector of tools) {
    const tool = page.locator(`.quick-replies ${selector}`);
    await tool.scrollIntoViewIfNeeded();
    await expect(tool).toBeVisible();
  }
  // Compositor: adjuntar, ampliar, Programar, Agendar cita y Enviar (lima).
  for (const selector of [
    '[data-action="attach"]',
    '[data-action="compose-expand"]',
    '[data-action="sch-open"]',
    '[data-action="apt-open"]',
  ]) {
    const tool = page.locator(`.compose ${selector}`);
    await tool.scrollIntoViewIfNeeded();
    await expect(tool).toBeVisible();
  }
  await expect(page.locator('#send-button')).toHaveCSS('background-color', LIME);
  await expectNiebla(page, 'inbox-chat', testInfo);

  watcher.done();
  await teamContext.close();
  await customerContext.close();
});
