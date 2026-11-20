/**
 * Pantalla «Asistentes conectados» (docs/PLAN_MCP_OAUTH.md): las aplicaciones de asistente (Claude y otras) a las que
 * alguien del equipo dio permiso con un clic para usar el conector del CRM. Una tarjeta por conexión con la aplicación,
 * la marca, los permisos, quién la autorizó, cuándo y su último uso; «Desconectar» la revoca al instante.
 * Administración ve todas las de sus marcas; los demás, sólo las suyas (lo decide GET /api/mcp-oauth/connections).
 * Arriba, la dirección del conector para pegar en la aplicación, con «Copiar», y los tres pasos para conectar.
 * Las llaves de la API (Operación → Sistema → API) siguen sirviendo igual: esta pantalla no las toca.
 */
import { html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { confirm } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

const FECHA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const fecha = instante => (instante ? FECHA.format(new Date(instante)) : 'Todavía no');

function tarjeta(c) {
  const lectura = c.scopes.filter(s => s.kind === 'read');
  const escritura = c.scopes.filter(s => s.kind === 'write');
  return html`<li class="k-item as-conexion" data-key="${c.id}">
    <div class="k-item__head">
      <div class="k-item__name">
        <h2 class="k-item__title">${c.clientName}</h2>
        <span class="k-chip k-chip--ok">Conectado</span>
      </div>
      <button type="button" class="k-btn k-btn--danger" data-do="desconectar" data-id="${c.id}" data-name="${c.clientName}">
        Desconectar
      </button>
    </div>
    <dl class="as-datos">
      <div class="k-piece" data-tone="lilac">
        <dt class="k-piece__label">Marca</dt>
        <dd class="k-piece__value">${c.brandName}</dd>
      </div>
      <div class="k-piece">
        <dt class="k-piece__label">Autorizó</dt>
        <dd class="k-piece__value">${c.mine ? `${c.userName} (tú)` : c.userName}</dd>
      </div>
      <div class="k-piece">
        <dt class="k-piece__label">Desde</dt>
        <dd class="k-piece__value">${fecha(c.createdAt)}</dd>
      </div>
      <div class="k-piece" data-tone="sky">
        <dt class="k-piece__label">Último uso</dt>
        <dd class="k-piece__value">${fecha(c.lastUsedAt)}</dd>
      </div>
    </dl>
    <div class="as-permisos">
      ${when(
        lectura.length,
        () =>
          html`<p class="as-grupo">Puede consultar</p>
            <ul class="as-lista">
              ${lectura.map(s => html`<li data-key="${s.key}">${s.label}</li>`)}
            </ul>`,
      )}
      ${when(
        escritura.length,
        () =>
          html`<p class="as-grupo">Puede cambiar</p>
            <ul class="as-lista">
              ${escritura.map(s => html`<li data-key="${s.key}">${s.label}</li>`)}
            </ul>`,
      )}
    </div>
    <p class="k-hint">
      Aplicación: nombre que ella misma declara${c.clientHost ? `; identidad publicada en ${c.clientHost}` : ''}${
        c.redirectHost ? `; regresa a ${c.redirectHost}` : ''
      }.
    </p>
  </li>`;
}

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    let datos = null;
    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Ajustes</span>
            <h1>Asistentes conectados</h1>
            <p class="k-lead">
              Conecta un asistente (por ejemplo Claude) al CRM con un clic, sin copiar llaves. Cada conexión ve UNA marca y sólo
              lo que permitas.
            </p>
          </div>
        </header>
        <div data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    render(cuerpo, loading('Cargando conexiones…'));

    function pintar() {
      const lista = datos.connections;
      render(
        cuerpo,
        html`<div class="k-stack">
          <section class="k-card k-stack as-conectar" aria-labelledby="${ctx.uid('conectar')}">
            <h2 class="k-card__title" id="${ctx.uid('conectar')}">Conectar un asistente</h2>
            ${when(
              datos.mcpUrl,
              () =>
                html`<div class="as-direccion">
                    <code class="as-url">${datos.mcpUrl}</code>
                    <button type="button" class="k-btn k-btn--primary" data-do="copiar">Copiar dirección</button>
                  </div>
                  <ol class="as-pasos">
                    <li>En la aplicación del asistente, agrega un conector personalizado y pega esta dirección.</li>
                    <li>Se abrirá esta página del CRM: entra con tu usuario si te lo pide.</li>
                    <li>Elige la marca, marca sólo los permisos que necesitas y pulsa «Permitir».</li>
                  </ol>`,
              () =>
                html`<p class="k-notice k-notice--warn">La conexión con un clic está apagada en este servidor. Las llaves de la API siguen funcionando.</p>`,
            )}
            <p class="k-hint">
              Si prefieres una llave de la API (por ejemplo para la terminal), sigue en Operación → Sistema → API: funciona igual que
              siempre.
            </p>
          </section>
          <section aria-labelledby="${ctx.uid('lista')}" class="k-stack">
            <h2 class="as-subtitulo" id="${ctx.uid('lista')}">
              ${datos.canSeeAll ? 'Conexiones de tus marcas' : 'Tus conexiones'} (${lista.length})
            </h2>
            ${when(
              lista.length,
              () => html`<ul class="k-cards">${lista.map(tarjeta)}</ul>`,
              () =>
                html`<div class="k-card">
                  ${empty({
                    title: 'Todavía no hay asistentes conectados',
                    text: 'Cuando alguien conecte un asistente con la dirección de arriba, aparecerá aquí.',
                  })}
                </div>`,
            )}
          </section>
        </div>`,
      );
    }

    async function cargar() {
      try {
        datos = await api.get('/api/mcp-oauth/connections');
      } catch (error) {
        if (montado && !isAbort(error))
          render(cuerpo, failure({ title: 'No se pudieron cargar las conexiones', error, retry: 'reintentar' }));
        return;
      }
      if (montado) pintar();
    }

    async function desconectar(boton) {
      const si = await confirm({
        title: 'Desconectar asistente',
        message: `«${boton.dataset.name}» dejará de poder usar el CRM en este momento. Para volver a usarlo habrá que conectarlo de nuevo.`,
        confirmLabel: 'Desconectar',
        danger: true,
      });
      if (!si || !montado) return;
      await api.post(`/api/mcp-oauth/connections/${boton.dataset.id}/revoke`, {});
      ctx.toast('Asistente desconectado.');
      await cargar();
    }

    async function copiar() {
      try {
        await globalThis.navigator.clipboard.writeText(datos.mcpUrl);
        ctx.toast('Dirección copiada.');
      } catch {
        ctx.toast('No se pudo copiar: selecciona la dirección y cópiala a mano.');
      }
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            copiar,
            desconectar: (_evento, boton) => desconectar(boton),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    ctx.onUnmount(() => {
      montado = false;
    });
    cargar();
  },
  // Las conexiones cambian poco: la lista se recarga al desconectar y al volver a la pantalla.
  onEvent() {},
};
