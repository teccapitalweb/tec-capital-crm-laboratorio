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
    await expect(stats.first()).toHaveCSS(
      'border-top-left-radius',
      testInfo.project.name === 'celular' ? '22px' : '28px',
    );
    const figure = stats.first().locator('strong');
    await expect(figure).toHaveCSS('font-size', testInfo.project.name === 'celular' ? '44px' : '56px');
    await expect(page.locator('.day-attend')).toHaveCSS('background-color', INK);
    await expect(page.locator('.day-agenda .panel-title h2')).toHaveText('Tu agenda de hoy');
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
  // Nombre corto: la tabla de Contactos (otra prueba) se desborda con un nombre largo sin espacios.
  const name = `Atención ${testInfo.project.name === 'celular' ? 'C' : 'E'} ${tag.slice(-4)}`;
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
  // La conversación es lo que más se ve: a 1366 × 800, con cabecera, interés, estado, resumen, herramientas y
  // compositor a la vista, el historial visible mide 300 px o más y «Enviar» está en pantalla sin desplazarse.
  if (testInfo.project.name === 'escritorio') {
    await expect(page.locator('#conv-summary :is(.sum-empty, .sum-card)')).toBeVisible();
    const seen = await page.evaluate(() => {
      const chat = document.querySelector('#chat').getBoundingClientRect();
      const hist = document.querySelector('#history').getBoundingClientRect();
      const foot = document.querySelector('.chat-bottom').getBoundingClientRect();
      const send = document.querySelector('#send-button').getBoundingClientRect();
      return {
        history: Math.min(hist.bottom, foot.top, chat.bottom) - Math.max(hist.top, chat.top),
        sendInView: send.top >= chat.top && send.bottom <= Math.min(chat.bottom, innerHeight),
      };
    });
    expect(seen.history, 'alto visible del historial a 1366 × 800').toBeGreaterThanOrEqual(300);
    expect(seen.sendInView, '«Enviar» a la vista sin desplazarse').toBe(true);
  }
  // Una herramienta se alcanza si, tras deslizar su fila, queda entera dentro de su fila y de la ventana.
  // El chat se vuelve a pintar cuando llega algo en vivo; si eso pasa a media comprobación, se repite con el botón nuevo.
  const reachable = locator =>
    expect(async () => {
      await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
      await expect(locator).toBeVisible({ timeout: 3000 });
      const inside = await locator.evaluate(
        el => {
          const r = el.getBoundingClientRect();
          const row = el.closest('.quick-replies, .compose-left, .compose') ?? el.parentElement;
          // una franja sin caja propia (display: contents) se mide con el pie del chat
          const box = row.getBoundingClientRect().width
            ? row.getBoundingClientRect()
            : el.closest('.chat-bottom').getBoundingClientRect();
          return (
            r.left >= box.left - 1 &&
            r.right <= box.right + 1 &&
            r.top >= 0 &&
            r.bottom <= innerHeight + 1 &&
            r.left >= 0 &&
            r.right <= innerWidth + 1
          );
        },
        null,
        { timeout: 3000 },
      );
      expect(inside, 'la herramienta queda a la vista tras deslizar su fila').toBe(true);
    }).toPass({ timeout: 15_000 });
  // Quién atiende y las diez herramientas (la fila se desliza de lado cuando no caben: cada una se alcanza).
  await expect(page.locator('.assist-actions .btn[data-chat-action]')).toBeVisible();
  await expect(page.locator('.assist-actions [data-chat-action="resolve"]')).toBeVisible();
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
  // A 1366 × 800 las diez están a la vista a la vez, sin deslizar nada: los atajos del catálogo son los más usados.
  if (testInfo.project.name === 'escritorio') {
    const shown = await page.evaluate(selectors => {
      const strip = document.querySelector('.quick-replies');
      const chat = document.querySelector('#chat').getBoundingClientRect();
      return {
        scrolls: strip.scrollWidth > strip.clientWidth + 1 || strip.scrollLeft > 0,
        outside: selectors.filter(selector => {
          const r = strip.querySelector(selector).getBoundingClientRect();
          return !(
            r.width > 0 &&
            r.left >= chat.left &&
            r.right <= chat.right &&
            r.top >= 0 &&
            r.bottom <= Math.min(innerHeight, chat.bottom)
          );
        }),
      };
    }, tools);
    expect(shown.scrolls, 'la fila de herramientas no se desliza a 1366 × 800').toBe(false);
    expect(shown.outside, 'herramientas fuera de la vista a 1366 × 800').toEqual([]);
  }
  for (const selector of tools) await reachable(page.locator(`.quick-replies ${selector}`));
  // Compositor: adjuntar, ampliar, Programar, Agendar cita y Enviar (lima).
  for (const selector of [
    '[data-action="attach"]',
    '[data-action="compose-expand"]',
    '[data-action="sch-open"]',
    '[data-action="apt-open"]',
  ])
    await reachable(page.locator(`.compose ${selector}`));
  await reachable(page.locator('#send-button'));
  await expect(page.locator('#send-button')).toHaveCSS('background-color', LIME);
  await expectNiebla(page, 'inbox-chat', testInfo);

  watcher.done();
  await teamContext.close();
  await customerContext.close();
});
