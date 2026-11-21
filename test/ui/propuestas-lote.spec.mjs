import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { AUTH, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// «Propuestas del asistente» por lote (public/screens/propuestas): un asistente de mentira (una llave de la API) arma
// tres reglas en borrador, un curso con su apertura en borrador y la imagen del curso (subida por la dirección de un
// solo uso), y propone encender las reglas, publicar la apertura y aprobar la imagen. En la pantalla: la tarjeta de la
// imagen la muestra; se eligen las cinco, una regla cambia antes de aprobar (queda obsoleta) y «Aprobar las
// seleccionadas» pide UNA confirmación que lista cada acción con su nombre; al terminar dice qué se aprobó y qué no.
// Una imagen PNG real de 1×1 (inventada) para que el navegador la pinte.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

async function assistant(request, baseURL) {
  const made = await request.post('/api/integrations/keys', {
    headers: { Origin: baseURL },
    data: {
      brandId: 'globalvet',
      name: 'Asistente de la prueba de lote ' + randomUUID().slice(0, 6),
      scopes: ['proposals', 'automation_drafts', 'config_drafts'],
    },
  });
  expect(made.status(), await made.text()).toBe(201);
  const token = (await made.json()).token;
  let id = 0;
  return async (name, args) => {
    const r = await request.post('/mcp', {
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      data: { jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } },
    });
    const out = (await r.json()).result;
    expect(out.isError, out.content[0].text).toBe(false);
    return JSON.parse(out.content[0].text);
  };
}

test('propuestas: aprobar por lote, con la imagen del curso y una que queda obsoleta', async ({
  page,
  baseURL,
}, testInfo) => {
  const watcher = watch(page);
  const tag = `${testInfo.project.name} ${randomUUID().slice(0, 6)}`;
  const tool = await assistant(page.request, baseURL);

  // ---- tres reglas en borrador y su propuesta de encenderlas
  const rules = [];
  for (const n of [1, 2, 3]) {
    const rule = await tool('crear_regla', {
      titulo: `Regla del lote ${n} · ${tag}`,
      definicion: {
        trigger: { type: 'keyword', mode: 'contains', words: [`lote-${n}-${randomUUID().slice(0, 8)}`] },
        actions: [{ type: 'send_text', text: `Respuesta del lote ${n}.` }],
      },
      clientRef: 'ui-lote-' + randomUUID(),
    });
    await tool('proponer_accion', { accion: 'activar_regla', id: rule.reglaId });
    rules.push(rule);
  }
  // ---- un curso (lo da de alta una persona), su apertura en borrador y su imagen subida por el conector
  const courseTitle = `Curso del lote ${tag}`;
  const course = await page.request.post('/api/catalogue/courses', {
    headers: { Origin: baseURL },
    data: { brandId: 'globalvet', title: courseTitle, syllabus: 'Tema 1 de prueba\nTema 2 de prueba' },
  });
  expect(course.status(), await course.text()).toBe(201);
  const courseId = (await course.json()).item.id;
  const draft = (await tool('listar_borradores_catalogo', {})).aperturasEnBorrador.find(e => e.cursoId === courseId);
  await tool('actualizar_apertura_borrador', {
    aperturaId: draft.aperturaId,
    revision: draft.revision,
    nombre: 'Marzo 2027',
    inicio: '2027-03-02 19:00',
    precio: 990,
    docente: 'Docente de prueba',
  });
  const prep = await tool('preparar_subida_imagen', { aperturaId: draft.aperturaId });
  const sent = await page.request.post(prep.direccion, { data: PNG_1X1, headers: { 'Content-Type': 'image/png' } });
  expect(sent.status(), await sent.text()).toBe(201);
  const imageId = (await sent.json()).imagenId;
  await tool('proponer_accion', { accion: 'aprobar_imagen', id: imageId });
  await tool('proponer_accion', { accion: 'publicar_apertura', id: draft.aperturaId });

  await page.goto('/crm');
  await page.locator('.nav [data-view="propuestas"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Propuestas del asistente');
  await settled(page);

  const cardOf = name => page.locator('#page .pp-tarjeta', { has: page.locator('.pp-nombre dd', { hasText: name }) });
  // la tarjeta de la imagen la muestra (del mismo origen) y dice a qué curso y apertura queda ligada
  const imageCard = page.locator('#page .pp-tarjeta', {
    has: page.locator('.k-item__title', { hasText: 'Aprobar la imagen del curso' }),
    hasText: courseTitle,
  });
  await expect(imageCard).toBeVisible();
  const img = imageCard.locator('.pp-imagen__img');
  await expect(img).toHaveAttribute('src', /^\/api\/library\/files\/[a-f0-9-]{36}$/);
  await img.scrollIntoViewIfNeeded();
  const served = await page.evaluate(
    async src => {
      const r = await fetch(src);
      return [r.status, r.headers.get('content-type')];
    },
    await img.getAttribute('src'),
  );
  expect(served).toEqual([200, 'image/png']);
  await expect.poll(() => img.evaluate(el => el.complete && el.naturalWidth)).toBe(1);
  await expect(imageCard.locator('.pp-detalle', { hasText: 'Apertura' }).first()).toContainText('Marzo 2027');

  // ---- elegir las cinco
  const picks = [
    ...rules.map(r => cardOf(r.titulo)),
    imageCard,
    page.locator('#page .pp-tarjeta', {
      has: page.locator('.k-item__title', { hasText: 'Publicar la apertura' }),
      hasText: courseTitle,
    }),
  ];
  for (const card of picks) {
    const box = card.getByRole('checkbox', { name: 'Elegir para el lote' });
    await box.check();
    await expect(box).toBeChecked();
  }
  const go = page.getByRole('button', { name: /Aprobar las seleccionadas \(\d+\)/ });
  await expect(go).toHaveText(/\(5\)/);
  // el botón de elegir todas (o quitarlas, si ya están todas las que se pueden aprobar)
  await expect(
    page.getByRole('button', { name: /^(Seleccionar todas las que puedo aprobar|Quitar la selección)$/ }),
  ).toBeVisible();
  await expectNiebla(page, 'propuestas', testInfo);

  // ---- la regla 2 cambia antes de aprobar: su propuesta quedará obsoleta
  const before = (await tool('listar_reglas', {})).reglas.find(r => r.reglaId === rules[1].reglaId);
  await tool('actualizar_regla', { reglaId: rules[1].reglaId, revision: before.revision, titulo: rules[1].titulo });

  await go.click();
  const dialog = page.locator('.k-dialog');
  await expect(dialog).toContainText('Aprobar 5 propuestas');
  const rows = dialog.locator('.pp-confirma-lote__fila');
  await expect(rows).toHaveCount(5);
  // primero se publica la apertura; la imagen va después
  await expect(rows.first()).toContainText('Publicar la apertura');
  const order = await rows.locator('.pp-confirma__accion').allTextContents();
  expect(order.indexOf('Publicar la apertura')).toBeLessThan(order.indexOf('Aprobar la imagen del curso'));
  for (const r of rules) await expect(dialog).toContainText(r.titulo);
  await dialog.getByRole('button', { name: 'Aprobar 5' }).click();

  const result = page.locator('#page .pp-resultado');
  await expect(result).toBeVisible();
  await expect(result.locator('.pp-resultado__fila')).toHaveCount(5);
  await expect(result.locator('.pp-resultado__fila[data-estado="aprobada"]')).toHaveCount(4);
  const stale = result.locator('.pp-resultado__fila[data-estado="obsoleta"]');
  await expect(stale).toHaveCount(1);
  await expect(stale).toContainText(rules[1].titulo);
  await expect(stale).toContainText('Cambió desde que se propuso');
  // las aprobadas pasan al historial
  for (const r of [rules[0], rules[2]])
    await expect(page.locator('#page .pp-historia', { hasText: r.titulo })).toContainText('Aprobada');
  await expect(page.locator('#page .pp-historia', { hasText: rules[1].titulo })).toContainText('Obsoleta');
  await settled(page);
  await expectNiebla(page, 'propuestas', testInfo);

  // la imagen quedó aprobada y la regla 2 sigue en borrador
  const reglas = (await tool('listar_reglas', {})).reglas;
  expect(reglas.find(r => r.reglaId === rules[0].reglaId).estado).toBe('active');
  expect(reglas.find(r => r.reglaId === rules[1].reglaId).estado).toBe('draft');
  expect((await tool('listar_borradores_catalogo', {})).imagenesEnBorrador.some(i => i.imagenId === imageId)).toBe(
    false,
  );

  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#page .k-page')).toHaveCount(0);
  watcher.done();
});
