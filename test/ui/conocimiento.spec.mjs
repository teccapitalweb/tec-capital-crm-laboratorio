import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Catálogo → Conocimiento: aprobar varios borradores de una vez (public/knowledge.js). Tres borradores propios de la
// prueba; la franja «borradores por aprobar» abre una ventana que muestra cada respuesta completa con su casilla. Se
// desmarca uno, otro cambia mientras la ventana está abierta (su revisión ya no es la que la persona vio) y «Aprobar las
// seleccionadas» aprueba sólo el que sigue igual: dice cuál no se pudo y nada se aprueba sin estar marcado.
test('conocimiento: aprobar varios borradores, con uno desmarcado y otro que cambió', async ({
  page,
  baseURL,
}, testInfo) => {
  const watcher = watch(page);
  const tag = `lote${randomUUID().slice(0, 8)}`;
  const headers = { Origin: baseURL };
  const made = [];
  for (const n of [1, 2, 3]) {
    const r = await page.request.post('/api/replies/knowledge', {
      headers,
      data: {
        brandId: 'globalvet',
        topic: 'general',
        question: `¿Pregunta ${n} del ${tag}?`,
        answer: `Respuesta ${n} del ${tag}, completa y sin precios.`,
        variants: [`variante ${n} ${tag}`],
      },
    });
    expect(r.status(), await r.text()).toBe(201);
    made.push((await r.json()).entry);
  }
  const statusOf = async id => {
    const all = (await (await page.request.get('/api/replies/knowledge?brand=globalvet')).json()).entries;
    return all.find(e => e.id === id).status;
  };

  await page.goto('/crm');
  await page.evaluate(() => window.TC.host.setView('courses'));
  await settled(page);
  await page.locator('[data-action="cat-tab"][data-id="knowledge"]').click();
  await settled(page);
  await page.locator('#cat-search-form input[name="query"]').fill(tag);
  await page.locator('#cat-search-form input[name="query"]').press('Enter');
  await settled(page);

  // la franja cuenta sólo los borradores que la lista muestra
  const bar = page.locator('.kn-bulk');
  await expect(bar).toContainText('3 borradores por aprobar');
  await expect(page.locator('.kn-card')).toHaveCount(3);
  await expectNiebla(page, 'conocimiento-lote-franja', testInfo);

  await bar.getByRole('button', { name: 'Revisar y aprobar varios' }).click();
  const modal = page.locator('#modal');
  await expect(modal).toBeVisible();
  const items = modal.locator('.kn-bulk-item');
  await expect(items).toHaveCount(3);
  // cada respuesta se lee completa antes de aprobar, y todas llegan marcadas
  for (const e of made) await expect(modal).toContainText(e.answer);
  await expect(modal.locator('input[name="ids"]:checked')).toHaveCount(3);
  await expectNiebla(page, 'conocimiento-lote-ventana', testInfo);

  // «Desmarcar todas» y «Marcar todas» funcionan; sin ninguna marcada no se envía nada
  await modal.getByRole('button', { name: 'Desmarcar todas' }).click();
  await expect(modal.locator('input[name="ids"]:checked')).toHaveCount(0);
  await modal.getByRole('button', { name: 'Aprobar las seleccionadas' }).click();
  await expect(modal.locator('.ops-feedback')).toHaveText('Marca al menos una respuesta.');
  await modal.getByRole('button', { name: 'Marcar todas', exact: true }).click();
  await expect(modal.locator('input[name="ids"]:checked')).toHaveCount(3);

  // la tercera se desmarca; la segunda cambia por fuera mientras la ventana sigue abierta
  await items
    .filter({ hasText: `¿Pregunta 3 del ${tag}?` })
    .locator('input')
    .uncheck();
  const edited = await page.request.patch('/api/replies/knowledge/' + made[1].id, {
    headers,
    data: {
      topic: 'general',
      courseId: null,
      question: made[1].question,
      variants: [`variante 2 ${tag}`],
      answer: `Respuesta 2 del ${tag}, cambiada después de abrir la ventana.`,
      expectedRevision: made[1].revision,
    },
  });
  expect(edited.ok(), await edited.text()).toBe(true);

  await modal.getByRole('button', { name: 'Aprobar las seleccionadas' }).click();
  const feedback = modal.locator('.ops-feedback');
  await expect(feedback).toContainText('Se aprobó 1 respuesta. No se pudo aprobar 1:');
  await expect(feedback).toContainText(`«¿Pregunta 2 del ${tag}?»`);
  // la aprobada sale de la lista; la que falló queda desmarcada y sin poder reenviarse desde esta ventana
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: `¿Pregunta 2 del ${tag}?` }).locator('input')).toBeDisabled();
  expect([await statusOf(made[0].id), await statusOf(made[1].id), await statusOf(made[2].id)]).toEqual([
    'approved',
    'draft',
    'draft',
  ]);

  await modal.locator('[data-action="close-modal"]').click();
  await settled(page);
  // quedan dos borradores a la vista: la franja lo dice
  await expect(page.locator('.kn-bulk')).toContainText('2 borradores por aprobar');

  // limpieza: las tres entradas de la prueba se archivan
  for (const e of made) {
    const all = (await (await page.request.get('/api/replies/knowledge?brand=globalvet')).json()).entries;
    const now = all.find(x => x.id === e.id);
    const r = await page.request.post(`/api/replies/knowledge/${e.id}/archive`, {
      headers,
      data: { expectedRevision: now.revision },
    });
    expect(r.ok(), await r.text()).toBe(true);
  }
  watcher.done();
});
