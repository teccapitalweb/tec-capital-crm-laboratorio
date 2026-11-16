import { test, expect } from '@playwright/test';
import { AUTH, adminContext, expectNiebla, settled, watch } from './helpers.mjs';

test('un mensaje del cliente llega en vivo al equipo y la respuesta vuelve al cliente', async ({
  browser,
}, testInfo) => {
  const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
  const question = `Hola, quiero informes ${tag}`;
  const answer = `Con gusto te ayudo ${tag}`;

  // El equipo ya está en Conversaciones antes de que el cliente escriba: el hilo debe aparecer sin recargar.
  const teamContext = await adminContext(browser);
  const team = await teamContext.newPage();
  const teamWatch = watch(team);
  await team.goto('/crm');
  await team.locator('.nav [data-view="inbox"]').click();
  await expect(team.locator('#breadcrumb-title')).toHaveText('Conversaciones');

  // El cliente se registra en la portada, abre una conversación y escribe.
  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  const customerWatch = watch(customer);
  await customer.goto('/');
  await customer.locator('#auth-form [name="name"]').fill(`Cliente ${tag}`);
  await customer.locator('#auth-form [name="username"]').fill(`cliente.${tag}`);
  await customer.locator('#auth-form [name="password"]').fill('Password-cliente-2026!');
  await customer.locator('#auth-form button[type="submit"]').click();
  await customer.locator('[data-action="new-chat"]:visible').first().click();
  await expect(customer.locator('#new-chat-edition option')).not.toHaveCount(0);
  await customer.locator('#new-chat-form button[type="submit"]').click();
  await customer.locator('#message-input').fill(question);
  await customer.locator('#send-button').click();
  await expect(customer.locator('#history')).toContainText(question);

  // El hilo aparece en la bandeja del equipo, se abre y se contesta.
  const thread = team.locator('.thread', { hasText: `Cliente ${tag}` });
  await expect(thread).toBeVisible();
  await thread.click();
  await expect(team.locator('#history')).toContainText(question);
  await team.locator('#message-input').fill(answer);
  await team.locator('#send-button').click();
  await expect(team.locator('#history')).toContainText(answer);

  // La respuesta llega al cliente sin recargar.
  await expect(customer.locator('#history')).toContainText(answer);

  teamWatch.done();
  customerWatch.done();
  await teamContext.close();
  await customerContext.close();
});

// Pantalla «Bandeja» nueva (public/screens/bandeja, en vista previa; docs/PLAN_BANDEJA_VISTAS.md): vistas con
// contador, búsqueda, filtro con la gramática común, guardar, editar y borrar una vista, y abrir una conversación
// en «Conversaciones». La persona que escribe es inventada y se crea por la API.
test.describe('bandeja nueva', () => {
  test.use({ storageState: AUTH.admin });

  test('la bandeja nueva muestra vistas con contador, busca, guarda una vista y abre la conversación', async ({
    page: equipo,
    playwright,
    baseURL,
  }, testInfo) => {
    const tag = `${testInfo.project.name}${Date.now().toString(36)}`;
    const nombre = `Bandeja ${tag} Prueba`;
    const palabra = `zafiro${tag}`;
    // Una persona escribe a GlobalVet por el laboratorio.
    const cliente = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { Origin: baseURL } });
    const alta = await cliente.post('/api/auth/register', {
      data: { username: `cli.${tag}`, name: nombre, password: 'Password-cliente-2026!' },
    });
    expect(alta.ok(), await alta.text()).toBe(true);
    const abierta = await cliente.post('/api/conversations', { data: { courseId: 'aves', channel: 'whatsapp' } });
    expect(abierta.ok(), await abierta.text()).toBe(true);
    const { conversation } = await abierta.json();
    const mensaje = await cliente.post(`/api/conversations/${conversation.id}/messages`, {
      data: { text: `Hola, pregunto por el ${palabra}`, clientRef: crypto.randomUUID() },
    });
    expect(mensaje.status(), await mensaje.text()).toBe(201);
    await cliente.dispose();

    const celular = testInfo.project.name === 'celular';
    const watcher = watch(equipo);
    const elegirVista = async id => {
      if (celular) {
        await equipo.locator('#page [data-do="abrir-vistas"]').click();
        await equipo.getByRole('dialog').locator(`[data-do="vista"][data-id="${id}"]`).click();
        await expect(equipo.getByRole('dialog')).toHaveCount(0);
      } else await equipo.locator(`#page .bj-cuerpo [data-do="vista"][data-id="${id}"]`).click();
    };

    await equipo.goto('/crm');
    await equipo.locator('.nav [data-view="bandeja"]').click();
    await expect(equipo.locator('#breadcrumb-title')).toHaveText('Bandeja');
    await elegirVista('all');
    const fila = equipo.locator('#page .bj-fila', { hasText: nombre });
    await expect(fila).toBeVisible();
    await expect(fila).toContainText('WhatsApp');
    await expect(fila).toContainText('Plan sanitario para aves');
    // El contador de «Todas» llega del servidor (en celular, en el botón «Vistas»).
    if (celular) await expect(equipo.locator('#page [data-do="abrir-vistas"]')).toContainText(/Todas · \d/);
    else await expect(equipo.locator('#page .bj-cuerpo [data-id="all"] .bj-vista__cuenta')).toHaveText(/^\d/);
    await settled(equipo);
    await expectNiebla(equipo, 'bandeja', testInfo);

    // Buscar por una palabra del mensaje
    const buscar = equipo.locator('#page [data-do="buscar"]');
    await buscar.fill(palabra);
    await expect(equipo.locator('#page .bj-fila')).toHaveCount(1);
    await expect(fila).toContainText(`Mensaje: Hola, pregunto por el ${palabra}`);
    await buscar.fill('');
    await expect(equipo.locator('#page .bj-fila').nth(1)).toBeVisible();

    // Filtrar (Estado es Abierta) y guardar la vista
    await equipo.locator('#page .bj-filtros > summary').click();
    const filtros = equipo.locator('#page [data-slot="condiciones"]');
    await filtros.locator('[data-do="k-cond-add-group"]').click();
    await filtros.locator('[data-do="k-cond-field"]').first().selectOption('state');
    await filtros.locator('[data-do="k-cond-add-value"]').first().selectOption('open');
    await expect(equipo.locator('#page [data-slot="resumen"]')).toContainText('Abierta');
    await expect(fila).toBeVisible();
    await equipo.locator('#page [data-do="guardar-vista"]').click();
    const ventana = equipo.getByRole('dialog');
    await expect(ventana).toBeVisible();
    await settled(equipo, 'dialog.k-dialog');
    await expectNiebla(equipo, 'bandeja-guardar', testInfo);
    await ventana.locator('[name="name"]').fill(`Abiertas ${tag}`);
    await ventana.getByRole('button', { name: 'Guardar vista' }).click();
    await expect(ventana).toHaveCount(0);
    if (celular) await expect(equipo.locator('#page [data-do="abrir-vistas"]')).toContainText(`Abiertas ${tag}`);
    else await expect(equipo.locator('#page .bj-cuerpo [aria-current="true"]')).toContainText(`Abiertas ${tag}`);
    await expect(fila).toBeVisible();

    // Editar el nombre y borrarla
    await equipo.locator('#page [data-do="editar-vista"]').click();
    await ventana.locator('[name="name"]').fill(`Abiertas ${tag} (2)`);
    await ventana.getByRole('button', { name: 'Guardar cambios' }).click();
    await expect(ventana).toHaveCount(0);
    await expect(equipo.locator('#page')).toContainText(`Abiertas ${tag} (2)`);
    await equipo.locator('#page [data-do="borrar-vista"]').click();
    await equipo.getByRole('dialog').getByRole('button', { name: 'Borrar' }).click();
    await expect(equipo.locator('#page')).not.toContainText(`Abiertas ${tag} (2)`);

    // Salir y volver conserva la vista elegida; abrir una fila lleva a la conversación de siempre
    await elegirVista('all');
    await equipo.locator('.nav [data-view="day"]').click();
    await expect(equipo.locator('#breadcrumb-title')).toHaveText('Mi día');
    await equipo.locator('.nav [data-view="bandeja"]').click();
    await expect(fila).toBeVisible();
    await fila.click();
    await expect(equipo.locator('#breadcrumb-title')).toHaveText('Conversaciones');
    await expect(equipo.locator('#history')).toContainText(palabra);

    watcher.done();
  });
});
