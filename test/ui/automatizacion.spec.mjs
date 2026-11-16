import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AUTH, ensureUser, expectNiebla, settled, watch } from './helpers.mjs';

test.use({ storageState: AUTH.admin });

// Cifras de ejemplo para la pestaña Rendimiento: dos conversaciones de este recorrido escritas en la bitácora (una
// terminó y otra dejó de contestar en el mensaje). Las horas son fijas respecto a ahora: nada depende de que el reloj
// avance.
async function seedSessions(page, playwright, baseURL, flowId) {
  const { flow } = await (await page.request.get(`/api/chatflows/${flowId}`)).json();
  const message = flow.graph.nodes.find(n => n.type === 'message').id;
  const db = new DatabaseSync(join(process.env.CRM_UI_DATA_DIR, 'laboratorio.sqlite'), { timeout: 5000 });
  try {
    let conv = db.prepare('SELECT id FROM conversations WHERE brand_id=? LIMIT 1').get(flow.brandId)?.id;
    if (!conv) {
      const request = await playwright.request.newContext({ baseURL });
      await ensureUser(request, baseURL, {
        username: 'persona.ui',
        name: 'Persona de prueba',
        password: 'Password-ui-2026!',
      });
      const courseId = db.prepare('SELECT id FROM courses WHERE brand_id=? LIMIT 1').get(flow.brandId).id;
      const created = await request.post('/api/conversations', {
        headers: { Origin: baseURL },
        data: { courseId, channel: 'whatsapp' },
      });
      conv = (await created.json()).conversation.id;
      await request.dispose();
    }
    const at = Date.now() - 3_600_000;
    for (const [i, outcome] of ['completed', 'timeout'].entries()) {
      const id = `ui-${flowId.slice(0, 8)}-${i}`;
      db.prepare(
        "INSERT INTO chatflow_sessions(id,brand_id,flow_id,flow_version,conversation_id,state,node_id,outcome,end_node_id,started_at,updated_at,ended_at) VALUES(?,?,?,1,?,'ended',?,?,?,?,?,?)",
      ).run(id, flow.brandId, flowId, conv, message, outcome, message, at + i, at + i, at + i + 1);
      const event = db.prepare(
        'INSERT INTO chatflow_events(brand_id,session_id,flow_id,flow_version,node_id,event,port,created_at) VALUES(?,?,?,1,?,?,?,?)',
      );
      event.run(flow.brandId, id, flowId, flow.graph.start, 'enter', null, at);
      event.run(flow.brandId, id, flowId, flow.graph.start, 'exit', 'next', at);
      event.run(flow.brandId, id, flowId, message, 'enter', null, at);
    }
  } finally {
    db.close();
  }
}

// La pantalla «Automatización» (en vista previa) conectada al servidor de recorridos: lista, crear, armar en el
// esquema, revisar con un problema y arreglarlo, guardar y recargar, publicar, activar, probar con el servidor, ver el
// rendimiento con cifras, pedir sugerencias y archivar. En computadora y en celular (donde se edita en el esquema).
test('automatización: un recorrido de punta a punta, del borrador al rendimiento', async ({
  page,
  playwright,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  const name = `Recorrido de prueba UI ${testInfo.project.name}`;
  const pageEl = page.locator('#page');
  const dialog = page.locator('dialog.k-dialog[open]');

  // La automatización de las marcas, apagada (así nace; si otra prueba la encendió, se apaga y se restaura al final):
  // un recorrido activo no atenderá y la pantalla debe decirlo.
  const headers = { Origin: baseURL };
  const automation = async () => (await (await page.request.get('/api/automation')).json()).brands;
  const wereOn = (await automation()).filter(b => b.enabled).map(b => b.id);
  const setAutomation = async (id, enabled) => {
    const current = (await automation()).find(b => b.id === id);
    await page.request.patch(`/api/automation/brands/${id}`, {
      headers,
      data: { enabled, expectedRevision: current.revision },
    });
  };
  for (const id of wereOn) await setAutomation(id, false);

  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Automatización');
  await expect(pageEl.locator('h1')).toHaveText('Recorridos');
  const notAttending = pageEl.locator('.au-atencion');
  await expect(notAttending).toContainText('no está atendiendo con recorridos');
  await expect(notAttending).toContainText('Operación → Ventas y cobro → Seguimientos → Automatización');
  await settled(page);
  await expectNiebla(page, 'automatizacion-lista', testInfo);

  // Cambiar de marca no esconde el selector: las marcas llegan completas aunque se pidan los recorridos de una sola
  const brandPicker = pageEl.locator('form[data-do="marca"] select');
  await expect(brandPicker).toBeVisible();
  const original = await brandPicker.inputValue();
  const others = (await brandPicker.locator('option').evaluateAll(options => options.map(o => o.value))).filter(
    value => value && value !== original,
  );
  expect(others.length, 'hay más de una marca para elegir').toBeGreaterThan(0);
  await brandPicker.selectOption(others[0]);
  await settled(page);
  await expect(brandPicker).toBeVisible();
  await expect(brandPicker).toHaveValue(others[0]);
  await brandPicker.selectOption(original);
  await settled(page);
  await expect(brandPicker).toHaveValue(original);

  // Crear en blanco
  await pageEl.locator('[data-do="nuevo"]').click();
  await dialog.getByLabel('Nombre').fill(name);
  await dialog.getByLabel('En blanco (sólo el Inicio)').check();
  await dialog.getByRole('button', { name: 'Crear' }).click();
  const editor = pageEl.locator('.lz');
  await expect(editor).toBeVisible();
  await expect(pageEl.locator('h1')).toContainText(name);
  await expect(pageEl.locator('h1')).toContainText('Borrador');
  await expect(editor.locator('.lz-node')).toHaveCount(1);

  // Los tipos que el servidor todavía no ejecuta se ven, pero no se agregan
  if (phone) await editor.locator('.lz-bar [data-do="paleta"]').click();
  const webhook = editor.locator('[data-do="paleta-tipo"][data-type="webhook"]');
  await expect(webhook).toHaveAttribute('aria-disabled', 'true');
  await expect(webhook).toContainText('Todavía no disponible');
  // la Lista y la Plantilla de WhatsApp ya se pueden agregar
  await expect(editor.locator('[data-do="paleta-tipo"][data-type="list"]')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(editor.locator('[data-do="paleta-tipo"][data-type="template"]')).not.toHaveAttribute(
    'aria-disabled',
    'true',
  );
  // aria-disabled (y no disabled) para que siga en el orden del teclado y diga por qué al pulsarlo
  await webhook.click({ force: true });
  await expect(editor.locator('.lz-node')).toHaveCount(1);
  await expect(editor.locator('[data-slot="aviso"]')).toContainText('todavía no llama a servicios externos');
  if (phone) await editor.locator('.lz-palette [data-do="paleta"]').click();

  // Agregar un Mensaje conectado al Inicio, desde el esquema
  if (!phone) await editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]').click();
  const exit = editor.locator('.lz-outline [data-do="fila-salida"]').first();
  await exit.focus();
  await exit.selectOption('new:message');
  await expect(editor.locator('.lz-node')).toHaveCount(2);
  await expect(editor.locator('.lz-outline .lz-row')).toHaveCount(2);
  if (phone) await page.keyboard.press('Escape');

  // Revisar: el mensaje vacío impide publicar; «Ir al paso» lleva a él y se arregla
  await pageEl.locator('[data-do="revisar"]').click();
  await expect(dialog).toContainText('hay que corregir');
  await expect(dialog.locator('.au-problema[data-level="error"]').first()).toContainText('Impide publicar');
  await dialog.locator('[data-do="ir-paso"]').first().click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator('.lz-panel-title')).toHaveText('Mensaje');
  await editor
    .locator('[data-slot="panel"] textarea')
    .first()
    .fill('Hola, {{nombre}}. Te comparto la información de {{curso}}.');
  // ya sin errores: queda una recomendación (la salida del mensaje sin conectar), que no impide publicar
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'warn');
  if (phone) await page.keyboard.press('Escape');
  await pageEl.locator('[data-do="revisar"]').click();
  await expect(dialog).toContainText('se puede publicar');
  await dialog.locator('[data-do="cerrar"]').click();

  // Guardar, recargar y sigue ahí
  await expect(editor.locator('[data-slot="estado"]')).toHaveText('Sin guardar');
  await editor.locator('.lz-bar [data-do="guardar"]').click();
  await expect(editor.locator('[data-slot="estado"]')).toHaveText('Guardado');
  await page.reload();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(pageEl.locator('h1')).toHaveText('Recorridos');
  await pageEl.locator('[data-do="abrir"]', { hasText: name }).first().click();
  await expect(editor.locator('.lz-node')).toHaveCount(2);
  await settled(page);
  await expectNiebla(page, 'automatizacion', testInfo);

  // Publicar y activar
  await pageEl.locator('[data-do="publicar"]').click();
  await expect(dialog).toContainText('Publicar la versión 1');
  await expect(dialog).toContainText('siguen con la versión con la que empezaron');
  await dialog.getByRole('button', { name: 'Publicar' }).click();
  await expect(pageEl.locator('h1')).toContainText('Publicado, sin activar');
  await pageEl.locator('[data-do="activar"]').click();
  // con la marca apagada, la ventana lo dice antes de confirmar y el estado es honesto
  await expect(dialog).toContainText('Ahora mismo no atenderá a nadie');
  await dialog.getByRole('button', { name: 'Activar de todos modos' }).click();
  await expect(pageEl.locator('h1')).toContainText('Activo, pero la marca no está atendiendo');
  await expect(notAttending).toContainText('La automatización de la marca está apagada');
  await expect(notAttending).toContainText('Operación → Ventas y cobro → Seguimientos');
  await settled(page);
  await expectNiebla(page, 'automatizacion-activo', testInfo);

  // Probar con el servidor: el mensaje sale con el curso real y no se envía nada
  await editor.locator('.lz-bar [data-do="probar"]').click();
  await expect(editor.locator('[data-slot="prueba"]')).toContainText('No se envía nada a nadie');
  await expect(editor.locator('.lz-chat')).toContainText('Te comparto la información de');
  await expect(editor.locator('.lz-sim-end')).toContainText('Fin de la prueba');
  await editor.locator('[data-do="prueba-cerrar"]').click();

  // Rendimiento con cifras
  const flowId = (await (await page.request.get('/api/chatflows')).json()).flows.find(f => f.name === name).id;
  await seedSessions(page, playwright, baseURL, flowId);
  await pageEl.locator('[data-do="pestana"][data-id="rendimiento"]').click();
  await pageEl.locator('[data-do="periodo"]').selectOption('7');
  const rend = pageEl.locator('[data-slot="p-rendimiento"]');
  await expect(rend.locator('.k-tile').first()).toContainText('2');
  await expect(rend.locator('.au-debiles')).toContainText('50 %');
  await expect(rend.locator('.au-tabla tbody tr')).toHaveCount(2);
  await settled(page);
  await expectNiebla(page, 'automatizacion-rendimiento', testInfo);
  // Sugerencias: sin IA configurada lo dice y no falla; la revisión por reglas sí sale
  await rend.locator('[data-do="sugerencias"]').click();
  await expect(rend.locator('.au-sug')).toContainText('no está configurada');
  await expect(rend.locator('.au-sugerencias')).toContainText('Pasar con una persona');
  // Las cifras sobre el recorrido
  await rend.locator('[data-do="ver-paso"]').first().click();
  await expect(editor).toBeVisible();
  await expect(editor.locator(phone ? '.lz-row-stats' : '.lz-node-stats').first()).toContainText('Entraron 2');

  // De vuelta a la lista: el estado a la vista; archivar para dejar limpio
  await pageEl.locator('[data-do="volver"]').click();
  const row = pageEl.locator(`[data-key="fila-${flowId}"]`);
  await expect(row).toContainText('Activo, pero la marca no está atendiendo');
  await row.locator('[data-do="archivar"]').click();
  await dialog.getByRole('button', { name: 'Archivar' }).click();
  await expect(pageEl.locator('[data-do="abrir"]', { hasText: name })).toHaveCount(0);

  // al salir no queda nada de la pantalla y la aplicación de siempre sigue funcionando
  await page.locator('.nav [data-view="day"]').click();
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  await expect(page.locator('#page .lz')).toHaveCount(0);
  await settled(page);
  await expect(page.locator('#page')).toContainText('Hola,');
  for (const id of wereOn) await setAutomation(id, true);
  watcher.done();
});

// Un PNG mínimo (firma y relleno): lo que acepta la subida única como imagen.
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 7)]);

// Pasos nuevos en la pantalla: un Mensaje con archivo que se sube desde el panel y una Lista de cinco opciones que se
// prueba con el servidor (se elige una fila y el recorrido sigue).
test('automatización: subir un archivo a un paso y probar una lista de cinco opciones', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(90_000);
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  const name = `Lista y archivo UI ${testInfo.project.name}`;
  const pageEl = page.locator('#page');
  const headers = { Origin: baseURL };
  const brands = (await (await page.request.get('/api/chatflows')).json()).brands;
  const brandId = brands.find(b => b.canManage).id;
  const row = (id, title) => ({ id, title, description: '', do: { type: 'goto' } });
  const graph = {
    v: 1,
    start: 'n1',
    variables: [],
    nodes: [
      { id: 'n1', type: 'start', x: 0, y: 0, data: {} },
      {
        id: 'm',
        type: 'message',
        x: 300,
        y: 0,
        data: { parts: [{ kind: 'media', fileId: '', caption: 'El temario' }] },
      },
      {
        id: 'l',
        type: 'list',
        x: 600,
        y: 0,
        data: {
          header: '',
          text: '¿Qué curso te interesa?',
          footer: '',
          button: 'Ver cursos',
          sections: [
            { title: '', rows: ['Aves', 'Perros', 'Gatos', 'Peces', 'Reptiles'].map((t, i) => row('r' + (i + 1), t)) },
          ],
          saveAs: 'curso',
        },
      },
      { id: 'e', type: 'end', x: 900, y: 0, data: { text: 'Elegiste {{var.curso}}' } },
    ],
    edges: [
      { from: 'n1', port: 'next', to: 'm' },
      { from: 'm', port: 'next', to: 'l' },
      ...['r1', 'r2', 'r3', 'r4', 'r5'].map(r => ({ from: 'l', port: 'opt:' + r, to: 'e' })),
    ],
  };
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const created = await page.request.post('/api/chatflows', {
    headers,
    data: { brandId, name, graph, start: { type: 'manual' }, clientRef: crypto.randomUUID() },
  });
  expect(created.status()).toBe(201);
  const flowId = (await created.json()).flow.id;

  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(pageEl.locator('h1')).toHaveText('Recorridos');
  const picker = pageEl.locator('form[data-do="marca"] select');
  if (await picker.count()) await picker.selectOption(brandId);
  await pageEl.locator('[data-do="abrir"]', { hasText: name }).first().click();
  const editor = pageEl.locator('.lz');
  await expect(editor.locator('.lz-node')).toHaveCount(4);
  // el archivo sin elegir impide publicar
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'error');

  // Abrir el Mensaje desde el esquema y subir una imagen desde su panel
  if (!phone) await editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]').click();
  await editor.locator('.lz-outline .lz-row-main', { hasText: 'Archivo' }).first().click();
  const panel = editor.locator('[data-slot="panel"]');
  await expect(panel.locator('.lz-upload')).toContainText('Subir archivo');
  await settled(page);
  await expectNiebla(page, 'automatizacion-archivo', testInfo);
  await panel
    .locator('[data-do="subir"]')
    .setInputFiles({ name: 'temario-ui.png', mimeType: 'image/png', buffer: PNG });
  await expect(panel.locator('select[data-do="ref"] option:checked')).toHaveText('temario-ui.png');
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).not.toHaveAttribute('data-level', 'error');
  if (phone) await page.keyboard.press('Escape');

  // Probar con el servidor: el archivo y la lista se ven; se elige «Peces» y el recorrido sigue con la variable
  await editor.locator('.lz-bar [data-do="probar"]').click();
  const chat = editor.locator('.lz-chat');
  await expect(chat).toContainText('temario-ui.png');
  await expect(chat).toContainText('Ver cursos');
  await expect(editor.locator('[data-do="prueba-opcion"]')).toHaveCount(5);
  await editor.locator('[data-do="prueba-opcion"]', { hasText: 'Peces' }).click();
  await expect(chat).toContainText('Elegiste Peces');
  await editor.locator('[data-do="prueba-cerrar"]').click();

  // Archivar para dejar limpio (no se guardó: se descarta lo que hay en pantalla)
  const current = (await (await page.request.get(`/api/chatflows/${flowId}`)).json()).flow;
  const archived = await page.request.post(`/api/chatflows/${flowId}/archive`, {
    headers,
    data: { expectedRevision: current.revision },
  });
  expect(archived.status()).toBe(200);
  watcher.done();
});
