import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import { adminContext, expectNiebla, settled, watch } from './helpers.mjs';

// Atender como en WhatsApp (docs/PLAN_ATENDER_COMO_WHATSAPP.md): un toque en Temario deja el material listo debajo de
// las herramientas con un solo «Enviar»; «Responder» (el botón al lado del mensaje en computadora, deslizar el
// mensaje en celular) cita el mensaje en el cuadro de escribir y en el globo enviado; y el menú se pliega a iconos.
// En computadora y en celular, sin errores y cumpliendo las reglas de diseño.
test('chat: material a un toque, responder citando y menú plegable', async ({ browser }, testInfo) => {
  const base = testInfo.project.use.baseURL;
  const headers = { Origin: base };
  const celular = testInfo.project.name === 'celular';
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const name = `Atender ${celular ? 'C' : 'E'} ${tag.slice(-4)}`;

  const customerContext = await browser.newContext();
  const customer = customerContext.request;
  await customer.post('/api/auth/register', {
    headers,
    data: { username: `cliente.atender.${tag}`, name, password: 'Password-cliente-2026!' },
  });
  const { conversation } = await (
    await customer.post('/api/conversations', { headers, data: { courseId: 'aves', channel: 'whatsapp' } })
  ).json();
  const asked = 'Hola, ¿me pasas el temario?';
  await customer.post(`/api/conversations/${conversation.id}/messages`, {
    headers,
    data: { text: asked, clientRef: randomUUID() },
  });

  const teamContext = await adminContext(browser);
  const page = await teamContext.newPage();
  const watcher = watch(page);
  await page.goto('/crm');
  await page.locator('.nav [data-view="inbox"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Conversaciones');
  await page.locator(`.thread[data-conversation="${conversation.id}"]`).click();
  await expect(page.locator('#history .message')).not.toHaveCount(0);

  // 1) Temario a un toque: la tarjeta con el texto, «Enviar» y «Elegir otro»; al enviar queda en el chat y la tarjeta se va
  await page.locator('.quick-replies [data-template="syllabus"]').click();
  const card = page.locator('#conv-material .cm-card');
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('data-kind', 'syllabus');
  await expect(card.locator('.cm-text')).toContainText('Temario');
  await expect(card.locator('[data-action="cat-materials"]')).toBeVisible();
  await expect(page.locator('.quick-replies [data-template="schedule"]')).toBeVisible();
  await card.locator('[data-action="cat-quick-send"]').click();
  await expect(page.locator('#history .message.outgoing .bubble').last()).toContainText('Temario', { timeout: 10_000 });
  await expect(card).toHaveCount(0);
  // «Quitar» cierra la tarjeta sin enviar
  await page.locator('.quick-replies [data-template="price"]').click();
  await expect(card).toHaveAttribute('data-kind', 'price');
  await card.locator('[data-action="cat-quick-clear"]').click();
  await expect(card).toHaveCount(0);

  // 2) Responder citando
  const incoming = page.locator('#history .message:not(.outgoing)', { hasText: asked }).first();
  if (celular) {
    // deslizar el mensaje a la derecha, como en la app de mensajería
    await incoming.evaluate(el => {
      const r = el.getBoundingClientRect();
      const touch = (x, y) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
      const fire = (type, x, y) =>
        el.dispatchEvent(
          new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [touch(x, y)] }),
        );
      const x = r.left + 20,
        y = r.top + r.height / 2;
      fire('touchstart', x, y);
      fire('touchmove', x + 30, y);
      fire('touchmove', x + 70, y);
      fire('touchend', x + 70, y);
    });
  } else {
    await incoming.hover();
    await incoming.locator('.msg-reply').click();
  }
  const bar = page.locator('#reply-bar');
  await expect(bar).toContainText('Respondiendo a ' + name);
  await expect(bar).toContainText('me pasas el temario');
  await page.locator('#message-input').fill('Claro, ya te lo mandé arriba.');
  await page.locator('#send-button').click();
  const replied = page.locator('#history .message.outgoing', { hasText: 'ya te lo mandé' });
  await expect(replied.locator('.msg-quote')).toContainText('me pasas el temario', { timeout: 10_000 });
  await expect(bar).toHaveCount(0);
  // la cita lleva al mensaje citado
  await replied.locator('.msg-quote').click();
  await expect(incoming).toHaveClass(/message-flash/);
  // el cliente también recibe la cita (y la pinta su chat)
  const list = await (await customer.get(`/api/conversations/${conversation.id}/messages`)).json();
  const last = list.messages.find(m => m.text === 'Claro, ya te lo mandé arriba.');
  expect(last.quoted.text).toContain('me pasas el temario');
  expect(last.quoted.senderKind).toBe('customer');
  // quitar la cita antes de enviar
  if (!celular) {
    await incoming.hover();
    await incoming.locator('.msg-reply').click();
    await expect(bar).toBeVisible();
    await bar.locator('[data-action="msg-reply-cancel"]').click();
    await expect(bar).toHaveCount(0);
  }

  // 3) Menú plegable (en celular el menú ya es de iconos y el botón no aparece)
  const toggle = page.locator('[data-menu-compact-toggle]');
  if (celular) await expect(toggle).toBeHidden();
  else {
    const width = () => page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().width);
    const full = await width();
    await toggle.click();
    await expect(page.locator('.workspace')).toHaveClass(/menu-compact/);
    expect(await width()).toBeLessThan(full - 100);
    await expect(page.locator('.sidebar .nav [data-view="inbox"] .nav-label-text')).toBeHidden();
    await expect(page.locator('.sidebar .nav [data-view="inbox"]')).toHaveAttribute('title', 'Conversaciones');
    // se recuerda al recargar, y se vuelve a abrir con el mismo botón
    await page.reload();
    await settled(page);
    await expect(page.locator('.workspace')).toHaveClass(/menu-compact/);
    await toggle.click();
    await expect(page.locator('.workspace')).not.toHaveClass(/menu-compact/);
    expect(await width()).toBe(full);
    await page.locator('.nav [data-view="inbox"]').click();
    await page.locator(`.thread[data-conversation="${conversation.id}"]`).click();
    await expect(page.locator('#history .message')).not.toHaveCount(0);
  }
  await expectNiebla(page, 'atender-whatsapp', testInfo);

  watcher.done();
  await teamContext.close();
  await customerContext.close();
});
