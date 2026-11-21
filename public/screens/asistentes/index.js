/**
 * Pantalla «Asistentes conectados» (docs/PLAN_MCP_OAUTH.md y docs/PLAN_MCP_CLAUDE.md), en dos pestañas:
 *
 * «Conexiones»: las aplicaciones de asistente (Claude y otras) a las que alguien del equipo dio permiso con un clic para
 * usar el conector del CRM. Una tarjeta por conexión con la aplicación, la marca, los permisos, quién la autorizó,
 * cuándo y su último uso; «Desconectar» la revoca al instante y «Ver actividad» abre su actividad.
 * Administración ve todas las de sus marcas; los demás, sólo las suyas (lo decide GET /api/mcp-oauth/connections).
 * Arriba, la dirección del conector para pegar en la aplicación, con «Copiar», y los tres pasos para conectar.
 * Las llaves de la API (Operación → Sistema → API) siguen sirviendo igual: esta pantalla no las toca.
 *
 * «Actividad»: qué hizo cada asistente y cada llave de la API con el conector (GET /api/mcp-activity, sólo de las
 * marcas que la persona administra). Cada renglón trae su texto en español ya armado por el servidor a partir de
 * claves cerradas: aquí no se arma texto con nada que haya mandado el asistente.
 */
import { html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { confirm } from '../../kit/components/dialog.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';
import { field } from '../../kit/components/form.js';
import { tabs } from '../../kit/components/tabs.js';

const FECHA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const fecha = instante => (instante ? FECHA.format(new Date(instante)) : 'Todavía no');

const RESULTADO = {
  ok: { texto: 'Hecha', chip: 'k-chip--ok' },
  rejected: { texto: 'Rechazada', chip: 'k-chip--bad' },
  invalid: { texto: 'Inválida', chip: 'k-chip--warn' },
  error: { texto: 'Error', chip: 'k-chip--bad' },
};
const TIPO = {
  read: { texto: 'Consulta', chip: 'k-chip--sky' },
  write: { texto: 'Escritura', chip: 'k-chip--lilac' },
  unknown: { texto: 'Desconocida', chip: 'k-chip--draft' },
};

function tarjeta(c, conActividad) {
  const lectura = c.scopes.filter(s => s.kind === 'read');
  const escritura = c.scopes.filter(s => s.kind === 'write');
  return html`<li class="k-item as-conexion" data-key="${c.id}">
    <div class="k-item__head">
      <div class="k-item__name">
        <h2 class="k-item__title">${c.clientName}</h2>
        <span class="k-chip k-chip--ok">Conectado</span>
      </div>
      <div class="k-actions">
        ${when(
          conActividad,
          () =>
            html`<button type="button" class="k-btn k-btn--ghost" data-do="ver-actividad" data-id="${'oauth:' + c.id}">
              Ver actividad
            </button>`,
        )}
        <button type="button" class="k-btn k-btn--danger" data-do="desconectar" data-id="${c.id}" data-name="${c.clientName}">
          Desconectar
        </button>
      </div>
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

// Un renglón de la actividad. Todo el texto viene del servidor (claves cerradas) o de los nombres que el equipo dio.
function renglon(a) {
  const r = RESULTADO[a.outcome] || RESULTADO.error;
  const t = TIPO[a.kind] || TIPO.unknown;
  const quien = a.source.kind === 'oauth' ? 'Asistente' : 'Llave de la API';
  return html`<li class="ac-item" data-outcome="${a.outcome}" data-key="${a.id}">
    <div class="ac-chips">
      <span class="${['k-chip', r.chip]}">${r.texto}</span>
      <span class="${['k-chip', t.chip]}">${t.texto}</span>
    </div>
    <p class="ac-texto">${a.text}</p>
    ${when(a.detail, () => html`<p class="ac-detalle">${a.detail}</p>`)}
    ${when(a.entity, () => html`<p class="ac-detalle">${a.entity.label} · <code class="ac-id">${a.entity.id}</code></p>`)}
    <p class="ac-meta">
      <span>${quien}: <strong>${a.source.name}</strong>${a.source.active ? '' : ' (ya no está activa)'}</span>
      <span>${a.brandName}</span>
      ${when(a.userName, () => html`<span>${a.source.kind === 'oauth' ? 'Autorizó' : 'Creó la llave'}: ${a.userName}</span>`)}
      <time datetime="${new Date(a.at).toISOString()}">${fecha(a.at)}</time>
    </p>
  </li>`;
}

// «2026-11-20» → el comienzo de ese día en la hora de quien mira (y el del día siguiente para «hasta»).
const dia = (valor, siguiente = false) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor || '');
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + (siguiente ? 1 : 0)).getTime() : null;
};

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    let datos = null;
    // Filtros de la actividad: se conservan al cambiar de pestaña.
    const filtros = { brand: '', source: '', desde: '', hasta: '', writes: false, problems: false };
    let actividad = null; // { respuesta, items, next }
    let panelActividad = null;
    let panelConexiones = null;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Ajustes</span>
            <h1>Asistentes conectados</h1>
            <p class="k-lead">
              Conecta un asistente (por ejemplo Claude) al CRM con un clic, sin copiar llaves. Cada conexión ve UNA marca y sólo
              lo que permitas. Por ahora sólo administración puede conectarlos, igual que crear una llave de la API.
            </p>
          </div>
        </header>
        <div data-slot="secciones"></div>
      </section>`,
    );

    const secciones = tabs(root.querySelector('[data-slot="secciones"]'), {
      label: 'Secciones de asistentes conectados',
      items: [
        {
          id: 'conexiones',
          label: 'Conexiones',
          mount: panel => {
            panelConexiones = panel;
            render(panel, loading('Cargando conexiones…'));
            cargar();
            return () => {
              panelConexiones = null;
            };
          },
        },
        {
          id: 'actividad',
          label: 'Actividad',
          mount: panel => {
            panelActividad = panel;
            render(panel, loading('Cargando actividad…'));
            cargarActividad();
            return () => {
              panelActividad = null;
            };
          },
        },
      ],
    });
    ctx.onUnmount(secciones.destroy);

    // ---- Conexiones
    function pintar() {
      if (!panelConexiones) return;
      const lista = datos.connections;
      render(
        panelConexiones,
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
                    <li>Se abrirá esta página del CRM: entra con tu usuario de administración si te lo pide.</li>
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
              () => html`<ul class="k-cards">${lista.map(c => tarjeta(c, datos.canSeeAll))}</ul>`,
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
        if (montado && panelConexiones && !isAbort(error))
          render(
            panelConexiones,
            failure({ title: 'No se pudieron cargar las conexiones', error, retry: 'reintentar' }),
          );
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

    // ---- Actividad
    function consulta(antes) {
      const q = new URLSearchParams();
      if (filtros.brand) q.set('brand', filtros.brand);
      if (filtros.source) q.set('source', filtros.source);
      if (filtros.writes) q.set('writes', '1');
      if (filtros.problems) q.set('problems', '1');
      const desde = dia(filtros.desde),
        hasta = dia(filtros.hasta, true);
      if (desde !== null) q.set('from', String(desde));
      if (hasta !== null) q.set('to', String(hasta));
      if (antes) q.set('before', String(antes));
      q.set('limit', '50');
      return '/api/mcp-activity?' + q;
    }

    async function cargarActividad({ mas = false } = {}) {
      let respuesta;
      try {
        respuesta = await api.get(consulta(mas ? actividad?.next : null));
      } catch (error) {
        if (montado && panelActividad && !isAbort(error))
          render(
            panelActividad,
            failure({ title: 'No se pudo cargar la actividad', error, retry: 'reintentar-actividad' }),
          );
        return;
      }
      if (!montado) return;
      actividad = {
        respuesta,
        items: mas && actividad ? [...actividad.items, ...respuesta.items] : respuesta.items,
        next: respuesta.next,
      };
      pintarActividad();
    }

    function barraFiltros(r) {
      const fuentes = r.sources.filter(s => !filtros.brand || s.brandId === filtros.brand);
      return html`<form class="k-filterbar ac-filtros" novalidate data-do="filtros" aria-label="Filtros de la actividad">
        ${when(r.brands.length > 1, () =>
          field(
            {
              name: 'brand',
              label: 'Marca',
              type: 'select',
              options: r.brands.map(b => ({ value: b.id, label: b.name })),
              emptyLabel: 'Todas',
            },
            { id: ctx.uid('ac-marca'), value: filtros.brand },
          ),
        )}
        ${field(
          {
            name: 'source',
            label: 'Conexión',
            type: 'select',
            options: fuentes.map(s => ({
              value: s.id,
              label: `${s.kind === 'oauth' ? 'Asistente' : 'Llave'}: ${s.name}${r.brands.length > 1 ? ` (${s.brandName})` : ''}${s.active ? '' : ' · inactiva'}`,
            })),
            emptyLabel: 'Todas',
          },
          { id: ctx.uid('ac-fuente'), value: filtros.source },
        )}
        ${field({ name: 'desde', label: 'Desde', type: 'date' }, { id: ctx.uid('ac-desde'), value: filtros.desde })}
        ${field({ name: 'hasta', label: 'Hasta', type: 'date' }, { id: ctx.uid('ac-hasta'), value: filtros.hasta })}
        <div class="k-row ac-pildoras">
          <button type="button" class="k-filter" data-do="solo" data-id="writes" aria-pressed="${filtros.writes}">
            Sólo escrituras
          </button>
          <button type="button" class="k-filter" data-do="solo" data-id="problems" aria-pressed="${filtros.problems}">
            Sólo rechazadas
          </button>
        </div>
      </form>`;
    }

    function pintarActividad() {
      if (!panelActividad || !actividad) return;
      const r = actividad.respuesta;
      const filtrado =
        filtros.brand || filtros.source || filtros.desde || filtros.hasta || filtros.writes || filtros.problems;
      render(
        panelActividad,
        html`<div class="k-stack">
          ${when(
            !r.allowed,
            () =>
              html`<div class="k-card">
                ${empty({
                  title: 'Sólo administración ve la actividad',
                  text: 'La actividad de los asistentes y de las llaves de la API la ve quien administra la marca.',
                })}
              </div>`,
            () =>
              html`<p class="k-hint">
                  Cada acción que un asistente conectado o una llave de la API hizo con el conector del CRM, de la más reciente a la más
                  antigua. Sólo se guarda qué hizo y cómo terminó, nunca lo que pidió ni lo que el CRM le respondió. Se conserva
                  ${r.retentionDays} días.
                </p>
                ${barraFiltros(r)}
                ${when(
                  actividad.items.length,
                  () =>
                    html`<ul class="ac-lista" aria-label="Actividad">
                        ${actividad.items.map(renglon)}
                      </ul>
                      ${when(
                        actividad.next,
                        () =>
                          html`<div class="k-actions">
                            <button type="button" class="k-btn" data-do="mas-actividad">Ver más</button>
                          </div>`,
                      )}`,
                  () =>
                    html`<div class="k-card">
                      ${empty(
                        filtrado
                          ? {
                              title: 'No hay actividad con estos filtros',
                              text: 'Cambia o quita los filtros para ver más.',
                            }
                          : {
                              title: 'Todavía no hay actividad',
                              text: 'Cuando un asistente conectado o una llave de la API use el conector, cada acción aparecerá aquí.',
                            },
                      )}
                    </div>`,
                )}`,
          )}
        </div>`,
      );
    }

    function aplicar(form) {
      const v = form.elements;
      const marca = v.namedItem('brand')?.value ?? '';
      if (marca !== filtros.brand) {
        filtros.brand = marca;
        // una conexión de otra marca ya no aplica
        const fuente = actividad?.respuesta.sources.find(s => s.id === filtros.source);
        if (fuente && marca && fuente.brandId !== marca) filtros.source = '';
        else filtros.source = v.namedItem('source')?.value ?? '';
      } else filtros.source = v.namedItem('source')?.value ?? '';
      filtros.desde = v.namedItem('desde')?.value ?? '';
      filtros.hasta = v.namedItem('hasta')?.value ?? '';
      cargarActividad();
    }

    function verActividad(boton) {
      filtros.source = boton.dataset.id;
      filtros.brand = '';
      actividad = null;
      secciones.select('actividad', { focus: true });
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            'reintentar-actividad': () => cargarActividad(),
            copiar,
            desconectar: (_evento, boton) => desconectar(boton),
            'ver-actividad': (_evento, boton) => verActividad(boton),
            solo: (_evento, boton) => {
              const cual = boton.dataset.id;
              if (cual !== 'writes' && cual !== 'problems') return;
              filtros[cual] = !filtros[cual];
              cargarActividad();
            },
            'mas-actividad': () => cargarActividad({ mas: true }),
          },
          change: {
            filtros: (_evento, form) => aplicar(form),
          },
          submit: {
            filtros: () => {},
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    ctx.onUnmount(() => {
      montado = false;
    });
  },
  // Las conexiones cambian poco: la lista se recarga al desconectar y al volver a la pantalla; la actividad, al filtrar.
  onEvent() {},
};
