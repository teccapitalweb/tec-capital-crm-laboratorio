/**
 * «Difusiones»: plantillas de WhatsApp enviadas por tandas a una audiencia (docs/PLAN_MOTOR_DIFUSIONES.md).
 *
 * Tres vistas: la lista de difusiones de la marca con su estado y contadores; el asistente para armar una
 * (plantilla → audiencia → valores y ritmo → revisar con el costo y los excluidos por motivo → enviar o programar);
 * y el detalle de una difusión con su avance en vivo, pausar, reanudar, cancelar y sus destinatarios por estado. Todo
 * lo decide el servidor (/api/broadcasts); aquí sólo se pinta. La vista de teléfono es neutra y de ejemplo.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { pagedTable } from '../../kit/components/table.js';
import { field } from '../../kit/components/form.js';
import { confirm } from '../../kit/components/dialog.js';
import { failure, loading } from '../../kit/components/feedback.js';
import { wizard } from '../../kit/components/wizard.js';

/** Lo vivo de este montaje, para que onEvent() llegue a la vista abierta. */
let enVivo = null;

const numero = n => new Intl.NumberFormat('es-MX').format(n ?? 0);
const fecha = ms =>
  ms ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms)) : '—';
const FUENTES = {
  nombre: 'Primer nombre del contacto',
  curso: 'Curso de la difusión',
  edicion: 'Edición de la difusión',
  marca: 'Nombre de la marca',
  cupon: 'Código del cupón',
};
const fuenteDe = clave =>
  FUENTES[clave] ?? (clave.startsWith('fijo.') ? 'Texto fijo de esta difusión' : 'Valor que da quien envía');
const ESTADOS = [
  ['', 'Todos'],
  ['queued', 'En cola'],
  ['sending', 'Enviando'],
  ['sent', 'Enviado'],
  ['delivered', 'Entregado'],
  ['read', 'Leído'],
  ['failed', 'Fallido'],
  ['skipped', 'Omitido'],
  ['cancelled', 'Cancelado'],
];

/** Vista de teléfono neutra: barra con la marca, la burbuja y los botones como filas. */
function telefono({ marca, texto, botones = [] }) {
  return html`<figure class="dif-telefono" aria-label="Vista de ejemplo del mensaje">
    <div class="dif-telefono__barra">${marca}</div>
    <div class="dif-telefono__fondo">
      <p class="dif-burbuja">${texto}<span class="dif-burbuja__pie">Responde BAJA para no recibir más.</span></p>
      ${botones.map(b => html`<span class="dif-boton" data-key="${b}">${b}</span>`)}
    </div>
    <figcaption class="dif-telefono__nota">
      Vista de ejemplo. El aspecto final depende de la aplicación de mensajería de cada persona.
    </figcaption>
  </figure>`;
}

const chipEstado = c =>
  html`<span class="${['k-chip', c.status === 'completed' && 'k-chip--ok']}">${c.statusLabel}</span>${when(
    c.rehearsal,
    () => html` <span class="k-chip">Ensayo: no se envía nada</span>`,
  )}`;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let vivo = true;
    let marca = ctx.keep.get('marca') ?? null;
    let marcas = [];
    let tabla = null;
    let asistente = null;
    let detalle = null; // {campaign, recipients}
    let filtro = ctx.keep.get('filtro') ?? '';
    let espera = null;
    const borrador = ctx.keep.get('borrador') ?? { clientRef: newClientRef(), cuando: 'ahora', modo: 'live' };
    ctx.keep.set('borrador', borrador);
    let opciones = null;
    let vistaPrevia = null;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">Difusiones</span>
            <h1>Difusiones</h1>
            <p class="k-lead">
              Una plantilla aprobada por Meta a cada persona de una audiencia, por tandas y a un ritmo. Nada sale sin
              consentimiento cuando hace falta, a quien pidió la baja ni dos veces a la misma persona.
            </p>
          </div>
          <div class="k-actions" data-slot="acciones"></div>
        </header>
        <div class="k-stack" data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    const acciones = root.querySelector('[data-slot="acciones"]');
    const vista = () => ctx.keep.get('vista') ?? 'lista';
    const ir = (nombre, id = null) => {
      ctx.keep.set('vista', nombre);
      ctx.keep.set('detalle', id);
      pintar();
    };
    function limpiar() {
      tabla?.destroy();
      tabla = null;
      asistente?.destroy();
      asistente = null;
      detalle = null;
      clearTimeout(espera);
      espera = null;
    }

    // ---- lista
    function pintarLista() {
      render(
        acciones,
        html`<button type="button" class="k-btn k-btn--primary" data-do="nueva">Nueva difusión</button>`,
      );
      render(cuerpo, html`<div data-slot="marcas"></div><div class="k-card" data-slot="tabla"></div>`);
      pintarMarcas();
      crearTabla();
    }
    function pintarMarcas() {
      const caja = cuerpo.querySelector('[data-slot="marcas"]');
      if (!caja) return;
      render(
        caja,
        html`${when(
          marcas.length > 1,
          () => html`<form class="k-card dif-marca" novalidate data-do="marca">
              ${field(
                {
                  name: 'marca',
                  label: 'Marca',
                  type: 'select',
                  options: marcas.map(b => ({ value: b.id, label: b.name })),
                },
                { id: ctx.uid('marca'), value: marca },
              )}
            </form>`,
        )}
          `,
      );
    }
    function crearTabla() {
      tabla = pagedTable(cuerpo.querySelector('[data-slot="tabla"]'), {
        label: 'Difusiones',
        rowKey: fila => fila.id,
        rowLabel: fila => fila.title,
        cards: true,
        chooser: false,
        columns: [
          {
            id: 'title',
            label: 'Difusión',
            fixed: true,
            cell: fila => html`<span class="dif-nombre">${fila.title}</span>
              <span class="k-hint">${fila.template?.name ?? ''}</span>`,
          },
          {
            id: 'status',
            label: 'Estado',
            // El motivo de una espera o de una detención (p. ej. el número volvió al modo escucha), con su texto.
            cell: fila =>
              html`${chipEstado(fila)}${when(fila.reasonLabel, () => html`<span class="dif-motivo">${fila.reasonLabel}</span>`)}`,
          },
          { id: 'recipients', label: 'Destinatarios', numeric: true, cell: fila => numero(fila.stats.recipients) },
          { id: 'sent', label: 'Enviados', numeric: true, cell: fila => numero(fila.stats.sentTotal) },
          { id: 'read', label: 'Leídos', numeric: true, cell: fila => numero(fila.stats.read) },
          { id: 'replied', label: 'Respondieron', numeric: true, cell: fila => numero(fila.stats.replied) },
          {
            id: 'actions',
            label: 'Acciones',
            cell: fila => html`<button type="button" class="k-btn" data-do="ver" data-id="${fila.id}">Ver</button>`,
          },
        ],
        async load({ cursor, signal }) {
          const offset = Number(cursor) || 0;
          const datos = await api.get(
            '/api/broadcasts',
            { ...(marca ? { brand: marca } : {}), limit: '20', offset: String(offset) },
            { signal },
          );
          if (vivo && datos.brands.length !== marcas.length) {
            marcas = datos.brands;
            if (!marca) marca = marcas.find(b => b.id === ctx.brand)?.id ?? marcas[0]?.id ?? null;
            pintarMarcas();
          }
          const siguiente = offset + datos.broadcasts.length;
          return { rows: datos.broadcasts, next: siguiente < datos.total ? String(siguiente) : null };
        },
        empty: { title: 'Sin difusiones', text: 'Arma la primera con «Nueva difusión».' },
      });
    }

    // ---- asistente
    const plantillaDe = id => opciones?.templates.find(t => t.id === id) ?? null;
    function pasoMensaje(caja) {
      const t = plantillaDe(borrador.plantilla);
      const curso = opciones.courses.find(c => c.id === borrador.curso);
      render(
        caja,
        html`<div class="dif-paso">
          <form class="k-stack" novalidate data-do="borrador">
            ${field(
              {
                name: 'plantilla',
                label: 'Plantilla aprobada',
                type: 'select',
                required: true,
                emptyLabel: 'Elige una plantilla',
                options: opciones.templates.map(x => ({
                  value: x.id,
                  label: `${x.name} · ${x.category === 'marketing' ? 'Promoción' : 'Utilidad'}${x.status === 'pending' ? ' · en revisión' : ''}`,
                })),
              },
              { id: ctx.uid('plantilla'), value: borrador.plantilla ?? '' },
            )}
            ${field(
              { name: 'titulo', label: 'Nombre de la difusión (opcional)', maxlength: 120, autocomplete: 'off' },
              { id: ctx.uid('titulo'), value: borrador.titulo ?? '' },
            )}
            ${field(
              {
                name: 'numero',
                label: 'Número que envía',
                type: 'select',
                emptyLabel: opciones.numbers.length ? 'Elige el número' : 'La marca no tiene números de WhatsApp',
                options: opciones.numbers.map(n => ({ value: n.id, label: n.label || n.id })),
              },
              { id: ctx.uid('numero'), value: borrador.numero ?? '' },
            )}
            ${field(
              {
                name: 'curso',
                label: 'Curso de la difusión',
                type: 'select',
                emptyLabel: 'Sin curso',
                options: opciones.courses.map(c => ({ value: c.id, label: c.title })),
              },
              { id: ctx.uid('curso'), value: borrador.curso ?? '' },
            )}
            ${when(curso, () =>
              field(
                {
                  name: 'edicion',
                  label: 'Edición',
                  type: 'select',
                  emptyLabel: 'La que corresponda',
                  options: (curso.editions ?? []).map(e => ({ value: e.id, label: e.name })),
                },
                { id: ctx.uid('edicion'), value: borrador.edicion ?? '' },
              ),
            )}
            ${field(
              {
                name: 'modo',
                label: 'Modo',
                type: 'select',
                options: [
                  { value: 'live', label: 'Envío real por WhatsApp' },
                  { value: 'rehearsal', label: 'Ensayo: recorre todo sin enviar nada' },
                ],
              },
              { id: ctx.uid('modo'), value: borrador.modo },
            )}
            ${when(
              !opciones.whatsappLive,
              () => html`<p class="k-hint">WhatsApp real está apagado: sólo se puede programar un ensayo.</p>`,
            )}
          </form>
          ${telefono({
            marca: marcas.find(b => b.id === marca)?.name ?? 'Marca',
            texto: t ? t.body : 'Elige una plantilla para ver el mensaje.',
            botones: t?.buttons ?? [],
          })}
        </div>`,
      );
    }
    function pasoPublico(caja) {
      const propias = opciones.audiences.filter(a => a.role !== 'suppression');
      const opcionesDe = propias.map(a => ({ value: a.id, label: `${a.name} (${numero(a.members)})` }));
      const lista = vacio => ({ emptyLabel: vacio, options: opcionesDe });
      render(
        caja,
        html`<form class="k-stack" novalidate data-do="borrador">
          ${field(
            {
              name: 'incluir',
              label: 'Enviar a',
              type: 'select',
              required: true,
              ...lista('Elige una audiencia'),
            },
            { id: ctx.uid('incluir'), value: borrador.incluir ?? '' },
          )}
          ${field(
            { name: 'excluir', label: 'Quitar a (opcional)', type: 'select', ...lista('Nadie más') },
            { id: ctx.uid('excluir'), value: borrador.excluir ?? '' },
          )}
          ${when(opciones.admin, () =>
            field(
              { name: 'consentimiento', label: 'Sólo a quien dio su consentimiento', type: 'checkbox' },
              { id: ctx.uid('consentimiento'), value: borrador.consentimiento !== false },
            ),
          )}
          <p class="k-hint">
            Las listas de exclusión de la marca, quien pidió la baja y quien no tiene WhatsApp se quitan siempre.
          </p>
        </form>`,
      );
    }
    function pasoValores(caja) {
      const t = plantillaDe(borrador.plantilla);
      const fijos = (t?.vars ?? []).filter(v => v?.startsWith('fijo.'));
      render(
        caja,
        html`<form class="k-stack" novalidate data-do="borrador">
          <ul class="k-stack">
            ${(t?.vars ?? []).map(
              (v, i) => html`<li data-key="${'v' + i}"><strong>${`{{${i + 1}}}`}</strong> ${fuenteDe(v || '')}</li>`,
            )}
          </ul>
          ${fijos.map(v =>
            field(
              { name: 'fijo_' + v.slice(5), label: `Texto fijo «${v.slice(5)}» (sin importes)`, maxlength: 60 },
              { id: ctx.uid('fijo-' + v.slice(5)), value: borrador.fijos?.[v.slice(5)] ?? '' },
            ),
          )}
          ${field(
            { name: 'ritmo', label: 'Mensajes por minuto', type: 'number', min: 6, max: 600 },
            { id: ctx.uid('ritmo'), value: borrador.ritmo ?? opciones.settings.ratePerMinute },
          )}
          ${field(
            {
              name: 'cuando',
              label: 'Cuándo sale',
              type: 'select',
              options: [
                { value: 'ahora', label: 'En cuanto se confirme' },
                { value: 'luego', label: 'En una fecha y hora' },
              ],
            },
            { id: ctx.uid('cuando'), value: borrador.cuando },
          )}
          ${when(borrador.cuando === 'luego', () =>
            field(
              { name: 'fecha', label: 'Fecha y hora (tu hora local)', type: 'datetime-local' },
              { id: ctx.uid('fecha'), value: borrador.fecha ?? '' },
            ),
          )}
        </form>`,
      );
    }
    function pintarRevision(caja, problema = '') {
      const p = vistaPrevia;
      if (!p) {
        render(caja, problema ? html`<p class="k-error">${problema}</p>` : loading('Calculando a quién le llega…'));
        return;
      }
      render(
        caja,
        html`<div class="dif-paso">
          <div class="k-stack">
            <p class="dif-cifra" role="status">
              <strong>${numero(p.willSend)}</strong> de ${numero(p.total)} personas recibirán el mensaje${
                p.rehearsal ? ' (ensayo: no se envía nada)' : ''
              }.
            </p>
            ${when(
              p.excluded.length,
              () => html`<ul class="dif-chips" aria-label="Quién queda fuera y por qué">
                ${p.excluded.map(e => html`<li class="k-chip" data-key="${e.reason}">${e.label}: ${numero(e.count)}</li>`)}
              </ul>`,
            )}
            ${when(
              p.cost,
              () => html`<p>
                Costo máximo estimado: <strong>${p.cost.max.label}</strong>${
                  p.cost.unverifiedRates ? ' · tarifas sin confirmar con Meta' : ''
                }${p.rehearsal ? ' · un ensayo no cuesta nada' : ''}
              </p>`,
            )}
            ${when(
              p.limits,
              () => html`<p class="k-hint">
                Límite diario del número: quedan ${p.limits.remaining === null ? 'sin tope conocido' : numero(p.limits.remaining)}${
                  p.limits.source === 'fallback' ? ' (tope conservador de la marca)' : ''
                }.
                Tiempo estimado: ${numero(p.schedule.estimatedMinutes)} min.
              </p>`,
            )}
            ${when(
              p.blockers.length,
              () => html`<div class="dif-aviso" role="alert">
                <p>Todavía no se puede enviar:</p>
                <ul class="dif-bloqueos">
                  ${p.blockers.map(b => html`<li data-key="${b.code}">${b.label}</li>`)}
                </ul>
              </div>`,
            )}
            ${when(
              !p.rehearsal && p.cost && p.cost.max.micros > 0 && !p.blockers.length,
              () => html`<form novalidate data-do="borrador">
                ${field(
                  { name: 'acepto', label: `Entiendo que Meta cobrará hasta ${p.cost.max.label}`, type: 'checkbox' },
                  { id: ctx.uid('acepto'), value: borrador.acepto === true },
                )}
              </form>`,
            )}
            ${when(problema, () => html`<p class="k-error">${problema}</p>`)}
          </div>
          ${telefono({
            marca: marcas.find(b => b.id === marca)?.name ?? 'Marca',
            texto: p.sample[0]?.rendered ?? p.message?.text ?? '',
            botones: plantillaDe(borrador.plantilla)?.buttons ?? [],
          })}
        </div>`,
      );
    }
    const cuerpoDraft = () => {
      const t = plantillaDe(borrador.plantilla);
      const fijos = {};
      for (const v of t?.vars ?? []) if (v?.startsWith('fijo.')) fijos[v.slice(5)] = borrador.fijos?.[v.slice(5)] ?? '';
      return {
        title: borrador.titulo || undefined,
        waTemplateId: borrador.plantilla,
        waNumber: borrador.numero || null,
        content: {
          context: borrador.curso ? { courseId: borrador.curso, editionId: borrador.edicion || undefined } : {},
          fixed: fijos,
        },
        segment: {
          version: 2,
          include: [{ audienceId: borrador.incluir }],
          ...(borrador.excluir ? { exclude: [{ audienceId: borrador.excluir }] } : {}),
        },
        ...(opciones.admin ? { requireConsent: borrador.consentimiento !== false } : {}),
        options: { mode: borrador.modo, ratePerMinute: Number(borrador.ritmo) || opciones.settings.ratePerMinute },
      };
    };
    async function guardarYPrevisualizar(caja) {
      vistaPrevia = null;
      pintarRevision(caja);
      try {
        const datos = cuerpoDraft();
        const out = borrador.id
          ? await api.patch(`/api/broadcasts/${borrador.id}`, { ...datos, expectedRevision: borrador.revision })
          : await api.post('/api/broadcasts', { ...datos, brandId: marca, clientRef: borrador.clientRef });
        borrador.id = out.campaign.id;
        borrador.revision = out.campaign.revision;
        vistaPrevia = (await api.post(`/api/broadcasts/${borrador.id}/preview`, {})).preview;
        if (vivo) pintarRevision(caja);
      } catch (error) {
        if (vivo && !isAbort(error)) pintarRevision(caja, error.message);
      }
    }
    async function pintarAsistente() {
      render(acciones, html`<button type="button" class="k-btn" data-do="volver">Volver a la lista</button>`);
      render(cuerpo, loading('Preparando el asistente…'));
      try {
        opciones = await api.get('/api/broadcasts/options', { brand: marca });
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
        return;
      }
      if (!vivo) return;
      if (!opciones.whatsappLive) borrador.modo = 'rehearsal';
      render(cuerpo, html`<div class="k-card" data-slot="asistente"></div>`);
      asistente = wizard(cuerpo.querySelector('[data-slot="asistente"]'), {
        label: 'Pasos de la difusión',
        current: ctx.keep.get('paso') ?? undefined,
        onStep: paso => ctx.keep.set('paso', paso),
        finishLabel: 'Enviar',
        steps: [
          { id: 'mensaje', title: 'Plantilla', hint: 'Qué se envía y desde qué número.' },
          { id: 'publico', title: 'Audiencia', hint: 'A quién se le envía.' },
          { id: 'valores', title: 'Valores y ritmo', hint: 'De dónde sale cada dato y cuándo sale.' },
          { id: 'revisar', title: 'Revisar', hint: 'Cuántos lo reciben, quién queda fuera y cuánto cuesta.' },
        ],
        onEnter(paso, caja) {
          if (paso.id === 'mensaje') pasoMensaje(caja);
          if (paso.id === 'publico') pasoPublico(caja);
          if (paso.id === 'valores') pasoValores(caja);
          if (paso.id === 'revisar') guardarYPrevisualizar(caja);
        },
        validate(paso) {
          leerPaso(asistente.body());
          if (paso.id === 'mensaje' && !borrador.plantilla) return 'Elige una plantilla.';
          if (paso.id === 'publico' && !borrador.incluir) return 'Elige a qué audiencia se envía.';
          if (paso.id === 'valores' && borrador.cuando === 'luego' && !borrador.fecha)
            return 'Elige la fecha y la hora.';
          if (paso.id === 'revisar') {
            if (!vistaPrevia) return 'Espera a que termine la revisión.';
            if (vistaPrevia.blockers.length) return vistaPrevia.blockers[0].label;
            const cobra = !vistaPrevia.rehearsal && vistaPrevia.cost?.max.micros > 0;
            if (cobra && borrador.acepto !== true) return 'Confirma el costo estimado.';
          }
          return true;
        },
        async onFinish() {
          const at = borrador.cuando === 'luego' && borrador.fecha ? new Date(borrador.fecha).getTime() : undefined;
          const { campaign } = await api.post(`/api/broadcasts/${borrador.id}/schedule`, {
            expectedRevision: borrador.revision,
            confirmAudience: vistaPrevia.willSend,
            acceptCost: borrador.acepto === true,
            ...(at ? { scheduledAt: at } : {}),
          });
          ctx.toast(at ? 'La difusión quedó programada.' : 'La difusión empezó a salir.');
          ctx.keep.delete('borrador');
          ctx.keep.delete('paso');
          Object.assign(borrador, { clientRef: newClientRef(), id: null, revision: null, acepto: false });
          ctx.keep.set('borrador', borrador);
          ir('detalle', campaign.id);
        },
      });
    }
    function leerPaso(caja) {
      for (const formulario of caja?.querySelectorAll('form[data-do="borrador"]') ?? []) {
        const v = formValues(formulario);
        for (const [k, valor] of Object.entries(v)) {
          if (k.startsWith('fijo_')) (borrador.fijos ??= {})[k.slice(5)] = valor;
          else borrador[k] = valor;
        }
      }
    }

    // ---- detalle
    async function cargarDetalle(id) {
      try {
        const [{ campaign }, recipients] = await Promise.all([
          api.get(`/api/broadcasts/${id}`),
          api.get(`/api/broadcasts/${id}/recipients`, { limit: '50', ...(filtro ? { state: filtro } : {}) }),
        ]);
        if (!vivo || ctx.keep.get('detalle') !== id) return;
        detalle = { campaign, recipients };
        pintarDetalle();
      } catch (error) {
        if (vivo && !isAbort(error)) render(cuerpo, failure({ error, retry: 'reintentar' }));
      }
    }
    function pintarDetalle() {
      const { campaign: c, recipients: r } = detalle;
      const s = c.stats;
      const puede = {
        pausar: ['scheduled', 'sending'].includes(c.status),
        reanudar: ['paused', 'stopped'].includes(c.status),
        cancelar: ['draft', 'scheduled', 'sending', 'paused', 'stopped'].includes(c.status),
      };
      render(acciones, html`<button type="button" class="k-btn" data-do="volver">Volver a la lista</button>`);
      render(
        cuerpo,
        html`<div class="k-card k-stack">
            <h2>${c.title}</h2>
            <p class="dif-chips">${chipEstado(c)}</p>
            ${when(c.reasonLabel, () => html`<p class="dif-aviso" role="status">${c.reasonLabel}</p>`)}
            <progress
              class="dif-avance"
              max="${Math.max(1, s.recipients)}"
              value="${s.sentTotal + s.failed}"
              aria-label="Avance del envío"
            ></progress>
            <dl class="dif-cifras">
              <div><dt>Destinatarios</dt><dd>${numero(s.recipients)}</dd></div>
              <div><dt>En cola</dt><dd>${numero(s.queued + s.sending)}</dd></div>
              <div><dt>Enviados</dt><dd>${numero(s.sentTotal)}</dd></div>
              <div><dt>Entregados</dt><dd>${numero(s.deliveredTotal)}</dd></div>
              <div><dt>Leídos</dt><dd>${numero(s.read)}</dd></div>
              <div><dt>Respondieron</dt><dd>${numero(s.replied)}</dd></div>
              <div><dt>Fallidos</dt><dd>${numero(s.failed)}</dd></div>
              <div><dt>Omitidos</dt><dd>${numero(s.skipped)}</dd></div>
            </dl>
            <p class="k-hint">Programada: ${fecha(c.scheduledAt)} · Empezó: ${fecha(c.startedAt)} · Terminó: ${fecha(c.finishedAt)}</p>
            <div class="dif-acciones">
              ${when(puede.pausar, () => html`<button type="button" class="k-btn" data-do="pausar">Pausar</button>`)}
              ${when(puede.reanudar, () => html`<button type="button" class="k-btn k-btn--primary" data-do="reanudar">Reanudar</button>`)}
              ${when(puede.cancelar, () => html`<button type="button" class="k-btn" data-do="cancelar">Cancelar</button>`)}
            </div>
          </div>
          ${when(
            r.reasons.length || r.failures.length,
            () => html`<div class="k-card k-stack">
              <h3>Por qué no les llegó</h3>
              <ul class="dif-chips">
                ${r.reasons.map(x => html`<li class="k-chip" data-key="${'o-' + x.reason}">${x.label}: ${numero(x.count)}</li>`)}
                ${r.failures.map(
                  (x, i) =>
                    html`<li class="k-chip" data-key="${'f-' + i}">${x.label}${x.code ? ` (${x.code})` : ''}: ${numero(x.count)}</li>`,
                )}
              </ul>
            </div>`,
          )}
          <div class="k-card k-stack">
            <form class="dif-marca" novalidate data-do="filtro">
              ${field(
                {
                  name: 'estado',
                  label: 'Destinatarios por estado',
                  type: 'select',
                  options: ESTADOS.map(([value, label]) => ({ value, label })),
                },
                { id: ctx.uid('estado'), value: filtro },
              )}
            </form>
            <p class="k-hint">${numero(r.total)} destinatarios${r.total > r.recipients.length ? ` · se ven los primeros ${r.recipients.length}` : ''}</p>
            <ul class="k-stack" aria-label="Destinatarios">
              ${r.recipients.map(
                x => html`<li class="dif-destinatario" data-key="${x.id}">
                  <strong>${x.name || 'Sin nombre'}</strong> · ${x.phone || '—'}
                  ${when(x.noNumber, () => html` <span class="k-chip dif-sin-numero">Sin número</span>`)} ·
                  <span class="k-chip">${x.stateLabel}</span>
                  ${x.reasonLabel || x.failReason ? ` ${x.reasonLabel ?? x.failReason}` : ''}
                  ${x.clickLabel ? ` · tocó «${x.clickLabel}»` : x.repliedAt ? ' · respondió' : ''}
                </li>`,
              )}
            </ul>
          </div>`,
      );
    }
    async function accion(tipo) {
      const c = detalle?.campaign;
      if (!c) return;
      if (tipo === 'cancelar') {
        const seguro = await confirm({
          title: `¿Cancelar «${c.title}»?`,
          message: 'A quien todavía no le salió ya no le saldrá. Lo enviado se conserva.',
          confirmLabel: 'Cancelar la difusión',
          danger: true,
        });
        if (!seguro) return;
      }
      const ruta = { pausar: 'pause', reanudar: 'resume', cancelar: 'cancel' }[tipo];
      const { campaign } = await api.post(`/api/broadcasts/${c.id}/${ruta}`, { expectedRevision: c.revision });
      ctx.toast(`${campaign.title}: ${campaign.statusLabel.toLowerCase()}.`);
      cargarDetalle(c.id);
    }

    function pintar() {
      limpiar();
      if (vista() === 'nueva') return pintarAsistente();
      if (vista() === 'detalle' && ctx.keep.get('detalle')) {
        render(cuerpo, loading('Cargando la difusión…'));
        return cargarDetalle(ctx.keep.get('detalle'));
      }
      return pintarLista();
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: pintar,
            nueva: () => ir('nueva'),
            volver: () => ir('lista'),
            ver: (_evento, boton) => ir('detalle', boton.getAttribute('data-id')),
            pausar: () => accion('pausar'),
            reanudar: () => accion('reanudar'),
            cancelar: () => accion('cancelar'),
          },
          change: {
            marca(_evento, formulario) {
              marca = formValues(formulario).marca;
              ctx.keep.set('marca', marca);
              tabla?.reload();
            },
            filtro(_evento, formulario) {
              filtro = formValues(formulario).estado ?? '';
              ctx.keep.set('filtro', filtro);
              if (detalle) cargarDetalle(detalle.campaign.id);
            },
            borrador(_evento, formulario) {
              const antes = { curso: borrador.curso, plantilla: borrador.plantilla, cuando: borrador.cuando };
              leerPaso(formulario.parentElement);
              const caja = asistente?.body();
              if (!caja) return;
              const paso = asistente.current();
              if (paso === 'mensaje' && (antes.curso !== borrador.curso || antes.plantilla !== borrador.plantilla))
                pasoMensaje(caja);
              if (paso === 'valores' && antes.cuando !== borrador.cuando) pasoValores(caja);
            },
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    enVivo = {
      marca: () => marca,
      // un aviso del motor: la lista o el detalle abiertos se ponen al día, como mucho una vez por segundo
      avisar(id) {
        if (espera) return;
        espera = setTimeout(() => {
          espera = null;
          if (!vivo) return;
          if (vista() === 'detalle' && detalle?.campaign.id === id) cargarDetalle(id);
          else if (vista() === 'lista') tabla?.reload();
        }, 1000);
      },
    };
    ctx.onUnmount(() => {
      vivo = false;
      enVivo = null;
      limpiar();
    });
    pintar();
  },

  /** El motor avisó de un cambio en una difusión de la marca que se está viendo. */
  onEvent(evento) {
    if (evento?.type === 'broadcasts.changed' && evento.brandId === enVivo?.marca()) enVivo.avisar(evento.data?.id);
  },
};
