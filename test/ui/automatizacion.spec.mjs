import { test, expect } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { AUTH, ensureUser, expectNiebla, settled, watch } from './helpers.mjs';
import { NODE_TYPES } from '../../public/kit/shared/flow-model.js';

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

// La marca de la lista: con pocas marcas se elige con píldoras; con muchas, con una lista desplegable.
async function pickBrand(pageEl, brandId) {
  const pill = pageEl.locator(`[data-do="marca-pildora"][data-id="${brandId}"]`);
  if (await pill.count()) await pill.click();
  else {
    const picker = pageEl.locator('form[data-do="marca"] select');
    if (await picker.count()) await picker.selectOption(brandId);
  }
}
const card = (pageEl, name) => pageEl.locator('.au-tarjeta', { hasText: name });

// La pantalla «Automatización» conectada al servidor de recorridos: lista, crear, armar en la vista Pasos, revisar con
// un problema y arreglarlo, guardar y recargar, publicar (con su aviso pendiente), activar, probar con el servidor, ver
// el rendimiento con cifras, pedir sugerencias y archivar. En computadora y en celular.
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
  const pills = pageEl.locator('[data-do="marca-pildora"]');
  expect(await pills.count(), 'hay más de una marca para elegir').toBeGreaterThan(1);
  const original = await pageEl.locator('[data-do="marca-pildora"][aria-pressed="true"]').getAttribute('data-id');
  const other = await pageEl.locator('[data-do="marca-pildora"][aria-pressed="false"]').first().getAttribute('data-id');
  await pickBrand(pageEl, other);
  await settled(page);
  await expect(pageEl.locator(`[data-do="marca-pildora"][data-id="${other}"]`)).toHaveAttribute('aria-pressed', 'true');
  await expect(pills).toHaveCount(await pills.count());
  await pickBrand(pageEl, original);
  await settled(page);
  await expect(pageEl.locator(`[data-do="marca-pildora"][data-id="${original}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );

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
  // abre en «Pasos», en computadora y en celular
  await expect(editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]')).toHaveText('Pasos');
  await expect(editor.locator('.lz-outline .lz-row')).toHaveCount(1);

  // Los tipos que el servidor todavía no ejecuta se ven, pero no se agregan (están en «Ver todos los tipos de paso»)
  if (phone) await editor.locator('.lz-bar [data-do="paleta"]').click();
  await editor.locator('[data-do="paleta-todos"]').click();
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
  await editor.locator('[data-do="paleta-todos"]').click();

  // Agregar un Mensaje: sin paso elegido cae al final del camino (después del Inicio), ya conectado
  await editor.locator('[data-do="paleta-tipo"][data-type="message"]').click();
  await expect(editor.locator('.lz-node')).toHaveCount(2);
  await expect(editor.locator('.lz-outline .lz-row')).toHaveCount(2);
  await expect(editor.locator('.lz-outline-title'), 'no queda ningún paso suelto').toHaveCount(0);
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
  await card(pageEl, name).locator('[data-do="abrir"]').click();
  await expect(editor.locator('.lz-node')).toHaveCount(2);
  await settled(page);
  await expectNiebla(page, 'automatizacion', testInfo);

  // Publicar con un aviso pendiente: la ventana lo nombra con su paso y pide confirmarlo
  await pageEl.locator('[data-do="publicar"]').click();
  await expect(dialog).toContainText('Publicar la versión 1 con 1 aviso');
  await expect(dialog.locator('.au-pub-avisos')).toContainText('Paso 2');
  await expect(dialog.locator('.au-pub-avisos')).toContainText('no está conectada');
  await expect(dialog).toContainText('siguen con la versión con la que empezaron');
  await dialog.getByRole('button', { name: 'Publicar de todos modos' }).click();
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
  // En «Editar» las pestañas van en la barra del editor; en las otras partes, arriba: se pulsa la que se ve.
  await pageEl.locator('[data-do="pestana"][data-id="rendimiento"]:visible').click();
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
  await expect(editor.locator('.lz-row-stats').first()).toContainText('Entraron 2');

  // De vuelta a la lista: el estado a la vista; archivar para dejar limpio
  await pageEl.locator('[data-do="volver"]').click();
  const row = pageEl.locator(`[data-key="fila-${flowId}"]`);
  await expect(row).toContainText('Activo, pero la marca no está atendiendo');
  await row.locator('[data-do="archivar"]').click();
  await dialog.getByRole('button', { name: 'Archivar' }).click();
  await expect(card(pageEl, name)).toHaveCount(0);

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
  await pickBrand(pageEl, brandId);
  await card(pageEl, name).locator('[data-do="abrir"]').click();
  const editor = pageEl.locator('.lz');
  await expect(editor.locator('.lz-node')).toHaveCount(4);
  // el archivo sin elegir impide publicar
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'error');

  // Abrir el Mensaje desde la lista de pasos y subir una imagen desde su panel
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

// Lo que salió mal al armar un recorrido a mano en producción, hecho como lo haría alguien por primera vez: duplicar
// un recorrido, agregar una Lista de cuatro filas después del saludo y publicar. La lista nace conectada, sus filas
// también, y lo que falta se dice en el propio paso. Además: todos los tipos de paso siguen a la mano en «Agregar
// paso», la vista elegida (Pasos o Lienzo) se recuerda y un cambio de «Ajustes» con versión publicada avisa que no
// está en servicio hasta publicar.
test('automatización: agregar una lista conectada después del saludo, publicar y avisos de ajustes', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(120_000);
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  const name = `Saludo UI ${testInfo.project.name}`;
  const pageEl = page.locator('#page');
  const dialog = page.locator('dialog.k-dialog[open]');
  const headers = { Origin: baseURL };
  const brands = (await (await page.request.get('/api/chatflows')).json()).brands;
  const brandId = brands.find(b => b.canManage).id;
  const graph = {
    v: 1,
    start: 's',
    variables: [],
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0, data: {} },
      { id: 'g', type: 'message', title: 'Saludo', x: 300, y: 0, data: { parts: [{ kind: 'text', text: 'Hola' }] } },
      { id: 'f', type: 'end', x: 600, y: 0, data: { text: 'Gracias' } },
    ],
    edges: [
      { from: 's', port: 'next', to: 'g' },
      { from: 'g', port: 'next', to: 'f' },
    ],
  };
  await page.goto('/crm');
  await expect(page.locator('#breadcrumb-title')).toHaveText('Mi día');
  const created = await page.request.post('/api/chatflows', {
    headers,
    data: { brandId, name, graph, start: { type: 'manual' }, clientRef: crypto.randomUUID() },
  });
  const originalId = (await created.json()).flow.id;

  // Duplicar desde la lista y abrir la copia
  await page.locator('.nav [data-view="automatizacion"]').click();
  await expect(pageEl.locator('h1')).toHaveText('Recorridos');
  await pickBrand(pageEl, brandId);
  await card(pageEl, name).first().locator('[data-do="duplicar"]').click();
  const copy = pageEl.locator('.au-tarjeta', { hasText: `${name} (copia)` });
  await expect(copy).toHaveCount(1);
  await expect(copy).toContainText('Borrador');
  await copy.locator('[data-do="abrir"]').click();
  const editor = pageEl.locator('.lz');
  await expect(editor.locator('.lz-outline .lz-row')).toHaveCount(3);

  // Todos los tipos de paso siguen a la mano: los mensajes primero, el resto con «Ver todos los tipos de paso»
  if (phone) await editor.locator('.lz-bar [data-do="paleta"]').click();
  const types = Object.values(NODE_TYPES)
    .filter(t => t.palette)
    .map(t => t.type);
  for (const type of ['message', 'buttons', 'list', 'question', 'template'])
    await expect(editor.locator(`[data-do="paleta-tipo"][data-type="${type}"]`)).toBeVisible();
  await expect(editor.locator('[data-do="paleta-tipo"][data-type="enroll"]')).toBeHidden();
  await editor.locator('[data-do="paleta-todos"]').click();
  for (const type of types) await expect(editor.locator(`[data-do="paleta-tipo"][data-type="${type}"]`)).toBeVisible();
  await editor.locator('[data-do="paleta-todos"]').click();
  if (phone) await editor.locator('.lz-palette [data-do="paleta"]').click();

  // Elegir el saludo y agregar una Lista: queda entre el saludo y el Fin, con su fila llevando al Fin
  await editor.locator('.lz-outline [data-node="g"] [data-do="fila"]').click();
  if (phone) {
    await page.keyboard.press('Escape');
    await editor.locator('.lz-bar [data-do="paleta"]').click();
  }
  await expect(editor.locator('.lz-palette-hint')).toContainText('después de «Saludo», ya conectado');
  await editor.locator('[data-do="paleta-tipo"][data-type="list"]').click();
  const rows = editor.locator('.lz-outline .lz-row');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(2)).toHaveAttribute('data-tone', 'lilac');
  await expect(rows.nth(2)).toHaveAttribute('data-current', 'true');
  await expect(editor.locator('.lz-outline-title'), 'nada quedó suelto').toHaveCount(0);

  // Cuatro filas con su texto: cada fila nueva lleva a donde llevan las demás (el Fin)
  const panel = editor.locator('[data-slot="panel"]');
  await expect(panel.locator('.lz-panel-step')).toHaveText(/Paso 3 · Lista/i);
  await panel.locator('[data-f="text"]').fill('¿Qué te gustaría saber?');
  for (let i = 1; i < 4; i += 1) await panel.locator('[data-do="lista-agregar"][data-f="sections.0.rows"]').click();
  for (const [i, title] of ['Precio', 'Fechas', 'Temario', 'Inscribirme'].entries())
    await panel.locator(`[data-f="sections.0.rows.${i}.title"]`).fill(title);
  const exits = panel.locator('.lz-exits .lz-exit select[data-do="salida"]');
  await expect(exits).toHaveCount(6); // cuatro filas, «Si no elige» y «Sin respuesta»
  for (let i = 0; i < 4; i += 1) await expect(exits.nth(i)).toHaveValue('f');
  await expect(panel.locator('.lz-exits')).toContainText('Inscribirme');
  // «Así lo ve la persona»: el saludo y la lista con sus cuatro filas, sin llamar al servidor
  if (phone) await editor.locator('[data-do="vista-abrir"]').click();
  const preview = editor.locator('.lz-preview');
  await expect(preview.locator('.lz-ph-bubble[data-current="true"]')).toContainText('¿Qué te gustaría saber?');
  await expect(preview.locator('.lz-ph-row')).toHaveCount(4);
  await expect(preview).toContainText('Hola');
  if (phone) {
    await editor.locator('[data-do="vista-cerrar"]').click();
    await page.keyboard.press('Escape');
  }
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'ok');
  await settled(page);
  await expectNiebla(page, 'automatizacion-pasos', testInfo);

  // Guardar y publicar: sin avisos pendientes, la ventana de siempre
  await editor.locator('.lz-bar [data-do="guardar"]').click();
  await expect(editor.locator('[data-slot="estado"]')).toHaveText('Guardado');
  await pageEl.locator('[data-do="publicar"]').click();
  await expect(dialog).toContainText('Publicar la versión 1');
  await expect(dialog).not.toContainText('aviso');
  await dialog.getByRole('button', { name: 'Publicar', exact: true }).click();
  await expect(pageEl.locator('h1')).toContainText('Publicado, sin activar');
  const flows = (await (await page.request.get(`/api/chatflows?brand=${brandId}`)).json()).flows;
  const copyId = flows.find(f => f.name === `${name} (copia)`).id;
  const published = (await (await page.request.get(`/api/chatflows/${copyId}/versions/1`)).json()).version.graph;
  const list = published.nodes.find(n => n.type === 'list');
  expect(published.edges.find(e => e.from === 'g').to).toBe(list.id);
  expect(published.edges.filter(e => e.from === list.id && e.to === 'f')).toHaveLength(4);

  // Ajustes: cambiar cómo empieza con una versión publicada avisa que no está en servicio hasta publicar
  await pageEl.locator('[data-do="ajustes"]').click();
  await dialog.getByLabel('Cómo empieza').selectOption('keyword');
  await dialog.getByLabel('Palabras clave').fill('lista');
  await dialog.getByRole('button', { name: 'Guardar ajustes' }).click();
  await expect(dialog).toContainText('todavía no en servicio');
  await expect(dialog).toContainText('Publicar');
  await dialog.getByRole('button', { name: 'Publicar después' }).click();
  await expect(pageEl.locator('.au-ajustes-pendientes')).toContainText('todavía no están en servicio');
  await pageEl.locator('[data-do="publicar"]').click();
  await dialog.getByRole('button', { name: 'Publicar', exact: true }).click();
  await expect(pageEl.locator('h1')).toContainText('Publicado, sin activar');
  await expect(pageEl.locator('.au-ajustes-pendientes')).toHaveCount(0);

  // La vista elegida se recuerda al volver a abrir un recorrido
  await editor.locator('.lz-bar [data-do="ver"][data-pane="canvas"]').click();
  await expect(editor.locator('.lz-canvas')).toBeVisible();
  await pageEl.locator('[data-do="volver"]').click();
  // Y al volver a abrirlo pide otra vez las listas de la marca: una plantilla recién adoptada o un material recién
  // aprobado se pueden elegir sin recargar la aplicación (antes se quedaba con las de la primera vez).
  const listsAgain = page.waitForRequest(request => request.url().includes('/api/chatflows/lists'));
  await card(pageEl, `${name} (copia)`).locator('[data-do="abrir"]').click();
  await listsAgain;
  await expect(editor.locator('.lz-bar [data-do="ver"][data-pane="canvas"]')).toHaveAttribute('aria-pressed', 'true');
  await editor.locator('.lz-bar [data-do="ver"][data-pane="outline"]').click();
  await expect(editor.locator('.lz-outline .lz-row')).toHaveCount(4);

  // Eliminar un paso de en medio con un solo destino: el saludo pasa a llevar al Fin; deshacer lo devuelve
  const listRow = rows.nth(2);
  const listId = await listRow.getAttribute('data-node');
  await listRow.locator('[data-do="fila"]').click();
  await panel.locator('[data-do="panel-eliminar"]').click();
  await expect(rows).toHaveCount(3);
  await expect(editor.locator('.lz-outline-title'), 'nada quedó suelto').toHaveCount(0);
  if (phone) await panel.locator('[data-do="panel-cerrar"]').click();
  await editor.locator('.lz-bar [data-do="deshacer"]').click();
  await expect(rows).toHaveCount(4);
  await expect(editor.locator(`.lz-outline [data-node="${listId}"]`)).toBeVisible();

  // Con filas que llevan a sitios distintos no se adivina: se elimina y se dice qué quedó sin camino, con «Ir al paso»
  await editor.locator(`.lz-outline [data-node="${listId}"] [data-do="fila"]`).click();
  await panel.locator('.lz-exits select[data-do="salida"]').first().selectOption('g');
  await panel.locator('[data-do="panel-eliminar"]').click();
  const notice = editor.locator('.lz-flash');
  await expect(notice).toContainText('sin camino');
  await expect(notice).toContainText('«Fin»');
  await notice.locator('[data-do="aviso-ir"]').first().click();
  await expect(editor.locator('.lz-panel-title')).toHaveText('Fin');
  if (phone) await panel.locator('[data-do="panel-cerrar"]').click();
  await expect(editor.locator('.lz-outline-title')).toContainText('Pasos sueltos');
  await editor.locator('.lz-bar [data-do="deshacer"]').click();
  await expect(rows).toHaveCount(4);
  await expect(editor.locator('.lz-outline-title')).toHaveCount(0);

  // Dejar limpio
  for (const id of [originalId, copyId]) {
    const current = (await (await page.request.get(`/api/chatflows/${id}`)).json()).flow;
    await page.request.post(`/api/chatflows/${id}/archive`, {
      headers,
      data: { expectedRevision: current.revision },
    });
  }
  watcher.done();
});

// «Inscribir en secuencia»: se agrega después del saludo como cualquier otro paso, se elige la secuencia de la marca en
// su panel y su nombre se ve en la lista de pasos y en el lienzo. La secuencia y el recorrido son propios de la prueba
// (nombre por proyecto y referencia nueva en cada vuelta) y se archivan al terminar.
test('automatización: inscribir en una secuencia desde un recorrido', async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const watcher = watch(page);
  const phone = testInfo.project.name === 'celular';
  // Nombres únicos en cada vuelta: la base de las pruebas de navegador es compartida y puede traer restos.
  const suffix = Date.now().toString(36);
  const name = `Secuencia UI ${testInfo.project.name} ${suffix}`;
  const title = `Seguimiento UI ${testInfo.project.name} ${suffix}`;
  const pageEl = page.locator('#page');
  const headers = { Origin: baseURL };
  const brands = (await (await page.request.get('/api/chatflows')).json()).brands;
  const brandId = brands.find(b => b.canManage).id;
  const made = await page.request.post('/api/sequences', {
    headers,
    data: {
      brandId,
      title,
      steps: [{ timing: { base: 'enrolled', amount: 1, unit: 'days' }, send: { kind: 'text', text: 'Hola' } }],
      clientRef: crypto.randomUUID(),
    },
  });
  expect(made.status()).toBe(201);
  const sequenceId = (await made.json()).sequence.id;
  const graph = {
    v: 1,
    start: 's',
    variables: [],
    nodes: [
      { id: 's', type: 'start', x: 0, y: 0, data: {} },
      { id: 'g', type: 'message', title: 'Saludo', x: 300, y: 0, data: { parts: [{ kind: 'text', text: 'Hola' }] } },
      { id: 'f', type: 'end', x: 600, y: 0, data: { text: 'Gracias' } },
    ],
    edges: [
      { from: 's', port: 'next', to: 'g' },
      { from: 'g', port: 'next', to: 'f' },
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
  await pickBrand(pageEl, brandId);
  await card(pageEl, name).first().locator('[data-do="abrir"]').click();
  const editor = pageEl.locator('.lz');
  const rows = editor.locator('.lz-outline .lz-row');
  await expect(rows).toHaveCount(3);

  // Elegir el saludo y agregar «Inscribir en secuencia» (con «Ver todos los tipos de paso»): queda conectado
  await editor.locator('.lz-outline [data-node="g"] [data-do="fila"]').click();
  if (phone) {
    await page.keyboard.press('Escape');
    await editor.locator('.lz-bar [data-do="paleta"]').click();
  }
  await editor.locator('[data-do="paleta-todos"]').click();
  const option = editor.locator('[data-do="paleta-tipo"][data-type="sequence"]');
  await expect(option).toContainText('Inscribir en secuencia');
  await expect(option).not.toHaveAttribute('aria-disabled', 'true');
  await option.click();
  await expect(rows).toHaveCount(4);
  await expect(editor.locator('.lz-outline-title'), 'nada quedó suelto').toHaveCount(0);

  // Sin secuencia elegida no se puede publicar; al elegirla, su nombre es el resumen del paso
  const panel = editor.locator('[data-slot="panel"]');
  await expect(panel.locator('.lz-panel-step')).toHaveText(/Paso 3 · Inscribir en secuencia/i);
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'error');
  const picker = panel.locator('select[data-do="ref"]');
  await expect(picker.locator(`option[value="${sequenceId}"]`)).toHaveText(title);
  await picker.selectOption(sequenceId);
  await expect(panel).toContainText('el recorrido sigue igual');
  // La secuencia nace apagada: ya no impide publicar, sólo queda el aviso de que mientras siga así nadie entra
  await expect(editor.locator('.lz-bar [data-slot="problemas"]')).toHaveAttribute('data-level', 'warn');
  await expect(panel).toContainText('está apagada');
  if (phone) await page.keyboard.press('Escape');
  await expect(rows.nth(2)).toContainText('Inscribir en secuencia');
  await expect(rows.nth(2).locator('.lz-row-sum')).toHaveText(title);
  await settled(page);
  await expectNiebla(page, 'automatizacion-secuencia', testInfo);

  // Guardar: el paso queda entre el saludo y el Fin, con la secuencia elegida
  await editor.locator('.lz-bar [data-do="guardar"]').click();
  await expect(editor.locator('[data-slot="estado"]')).toHaveText('Guardado');
  const saved = (await (await page.request.get(`/api/chatflows/${flowId}`)).json()).flow.graph;
  const step = saved.nodes.find(n => n.type === 'sequence');
  expect(step.data).toEqual({ sequenceId });
  expect(saved.edges.find(e => e.from === 'g').to).toBe(step.id);
  expect(saved.edges.find(e => e.from === step.id).to).toBe('f');

  // Dejar limpio: el recorrido y la secuencia de la prueba, archivados
  {
    const current = (await (await page.request.get(`/api/chatflows/${flowId}`)).json()).flow;
    await page.request.post(`/api/chatflows/${flowId}/archive`, {
      headers,
      data: { expectedRevision: current.revision },
    });
  }
  const seq = (await (await page.request.get(`/api/sequences/${sequenceId}`)).json()).sequence;
  const archived = await page.request.post(`/api/sequences/${sequenceId}/archive`, {
    headers,
    data: { expectedRevision: seq.revision },
  });
  expect(archived.status()).toBe(200);
  watcher.done();
});
