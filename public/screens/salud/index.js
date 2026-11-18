/**
 * Pantalla «Salud de WhatsApp» (X3, docs/PLAN_SALUD_NUMERO.md): una tarjeta por número con su estado, calidad, límite
 * diario y lo que queda hoy; el estado de la cuenta de WhatsApp Business; el historial de avisos y «Consultar ahora».
 * Sin WhatsApp real conectado lo dice con claridad y no falla. Los datos salen de GET /api/whatsapp/health; el
 * servidor decide qué ve cada quien (la cuenta, sólo con el permiso en todas las marcas).
 */
import { attrs, html, render, when } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { isAbort } from '../../kit/api.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';
import { formatNumber, meter } from '../../kit/charts.js';

const FECHA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const fecha = instante => (instante ? FECHA.format(new Date(instante)) : 'Nunca');
const TONO_CALIDAD = { green: 'k-chip--ok', yellow: 'k-chip--warn', red: 'k-chip--bad' };
const TONO_ESTADO = {
  connected: 'k-chip--ok',
  flagged: 'k-chip--warn',
  pending: 'k-chip--sky',
  restricted: 'k-chip--bad',
  banned: 'k-chip--bad',
  offline: 'k-chip--bad',
};
const NOMBRE = { approved: 'aprobado', pending_review: 'en revisión', declined: 'rechazado', rejected: 'rechazado' };
const REVISION = { approved: 'Aprobada', pending: 'En revisión', deferred: 'En revisión', rejected: 'Rechazada' };
const VERIFICACION = {
  verified: 'Verificado',
  pending: 'En revisión',
  rejected: 'Rechazada',
  not_verified: 'Sin verificar',
};
const PAGO = { ok: 'Correcto', missing: 'Falta', problem: 'Con problema', unknown: 'Sin dato' };
const CATEGORIAS = [
  ['marketing', 'Marketing'],
  ['utility', 'Utilidad'],
  ['service', 'Respuestas'],
];

/** «1,000 personas · quedan 980 hoy (estimado)», o lo que corresponda sin dato o sin límite. */
function textoLimite(limite) {
  if (limite.source === 'simulated') return 'Sin límite en el canal simulado';
  if (limite.unlimited) return 'Sin límite de Meta';
  const base = `${formatNumber(limite.limit)} personas en 24 h · quedan ${formatNumber(limite.remaining)} (estimado)`;
  return limite.source === 'default' ? `${base}. Meta aún no informa el nivel: se usa el más bajo.` : base;
}

/** Un dato en su pieza (rótulo en mayúsculas y valor); `tono` le da color de bloque. */
const dato = (rotulo, valor, tono = null) =>
  html`<div class="k-piece sal-dato" ${attrs({ 'data-tone': tono })}>
    <dt class="k-piece__label">${rotulo}</dt>
    <dd class="k-piece__value">${valor}</dd>
  </div>`;

function tarjetaNumero(numero, { puede }) {
  const nombre = numero.verifiedName
    ? `${numero.verifiedName}${numero.nameStatus ? ` (${NOMBRE[numero.nameStatus] ?? numero.nameStatus})` : ''}`
    : 'Sin dato';
  // Por qué se detiene cada categoría, sin repetir el mismo motivo.
  const estados = CATEGORIAS.map(([clave]) => numero.sending[clave]);
  const motivos = [...new Set(estados.filter(estado => !estado.ok).map(estado => estado.message))];
  return html`<article class="k-card sal-numero" data-key="${numero.accountRef}">
    <div class="sal-titulo">
      <h2>${numero.label}</h2>
      <span class="k-muted">${numero.brandName}</span>
    </div>
    <div class="k-row">
      <span class="${['k-chip', 'k-chip--lg', TONO_ESTADO[numero.status]]}">Estado: ${numero.statusLabel}</span>
      <span class="${['k-chip', 'k-chip--lg', TONO_CALIDAD[numero.quality]]}">Calidad: ${numero.qualityLabel}</span>
      ${when(!numero.enabled, () => html`<span class="k-chip k-chip--lg k-chip--draft">Apagado en el CRM</span>`)}
    </div>
    <dl class="sal-datos">
      ${dato('Número', numero.display || 'Sin dato', 'lilac')} ${dato('Nombre visible', nombre)}
      ${dato('Límite diario', textoLimite(numero.limit), 'sky')}
      <div class="k-piece sal-dato sal-dato--ancho">
        <dt class="k-piece__label">Puede enviar</dt>
        <dd class="k-row">
          ${CATEGORIAS.map(
            ([clave, rotulo]) =>
              html`<span class="${['k-chip', numero.sending[clave].ok ? 'k-chip--ok' : 'k-chip--bad']}">${rotulo}: ${numero.sending[clave].ok ? 'sí' : 'no'}</span>`,
          )}
        </dd>
      </div>
      ${dato('Última consulta', fecha(numero.checkedAt))}
      ${when(numero.lastWebhookAt, () => dato('Último aviso', fecha(numero.lastWebhookAt)))}
    </dl>
    ${when(motivos.length, () => html`<p class="k-notice k-notice--warn">${motivos.join(' ')}</p>`)}
    ${when(numero.error, () => html`<p class="k-notice k-notice--bad" role="status">${numero.error}</p>`)}
    ${when(
      puede,
      () =>
        html`<div class="k-actions">
          <button type="button" class="k-btn" data-do="consultar-numero" data-ref="${numero.accountRef}">Consultar este número</button>
        </div>`,
    )}
  </article>`;
}

function tarjetaCuenta(cuenta, uid) {
  const limite = cuenta.limit;
  const medidor =
    limite.limit && !limite.unlimited
      ? meter({
          label: 'Personas a las que se escribió primero en 24 h (estimado)',
          value: limite.used,
          limit: limite.limit,
          width: 280,
        })
      : null;
  return html`<section class="k-card k-stack" aria-labelledby="${uid('cuenta')}">
    <h2 class="k-card__title" id="${uid('cuenta')}">Cuenta de WhatsApp Business</h2>
    ${when(
      cuenta.restriction,
      () =>
        html`<p class="k-notice k-notice--bad" role="status">
          Meta restringió la cuenta${cuenta.restrictedUntil ? ` hasta el ${fecha(cuenta.restrictedUntil)}` : ''}: no se pueden iniciar
          conversaciones. Las respuestas dentro de la ventana de 24 h siguen saliendo.
        </p>`,
    )}
    <dl class="sal-datos">
      ${dato('Revisión de la cuenta', REVISION[cuenta.reviewStatus] ?? (cuenta.reviewStatus || 'Sin dato'))}
      ${dato(
        'Verificación del negocio',
        VERIFICACION[cuenta.businessVerification] ?? (cuenta.businessVerification || 'Sin dato'),
      )}
      ${dato('Método de pago', PAGO[cuenta.paymentStatus] ?? cuenta.paymentStatus)}
      ${dato('Límite diario', textoLimite(limite), 'sky')} ${dato('Última consulta', fecha(cuenta.checkedAt))}
    </dl>
    ${when(medidor, () => medidor.html)}
    ${when(cuenta.error, () => html`<p class="k-notice k-notice--bad" role="status">${cuenta.error}</p>`)}
    <p class="k-hint">El límite es de la cuenta y lo comparten todos sus números. Lo usado es una estimación del CRM; la cifra de Meta manda.</p>
  </section>`;
}

function historial(lista, uid) {
  return html`<section class="k-card k-stack" aria-labelledby="${uid('historial')}">
    <h2 class="k-card__title" id="${uid('historial')}">Historial de avisos</h2>
    ${when(
      lista.length,
      () =>
        html`<ul class="sal-historial">
          ${lista.map(
            item => html`<li data-key="${String(item.seq)}">
              <span class="sal-aviso"><strong>${item.subject}:</strong> ${item.text}</span>
              <span class="k-muted">${fecha(item.createdAt)} · ${item.source === 'webhook' ? 'Aviso de Meta' : 'Consulta a Meta'}</span>
            </li>`,
          )}
        </ul>`,
      () => html`<p class="k-muted">Todavía no hay cambios registrados.</p>`,
    )}
  </section>`;
}

let enVivo = null;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    let ocupado = false;
    let espera = 0;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">WhatsApp</span>
            <h1>Salud del canal</h1>
            <p class="k-lead">Estado, calidad y límite diario de cada número y de la cuenta de WhatsApp Business, con los avisos de Meta.</p>
          </div>
          <div class="k-actions" data-slot="acciones"></div>
        </header>
        <div data-slot="cuerpo"></div>
      </section>`,
    );
    const ranura = nombre => root.querySelector(`[data-slot="${nombre}"]`);
    render(ranura('cuerpo'), loading('Consultando la salud del canal…'));

    function pintar(datos) {
      const puede = Boolean(datos.canRefresh);
      render(
        ranura('acciones'),
        html`<button type="button" class="k-btn k-btn--primary" data-do="consultar" ${attrs({ disabled: !puede || ocupado })}>
          ${ocupado ? 'Consultando…' : 'Consultar ahora'}
        </button>`,
      );
      render(
        ranura('cuerpo'),
        html`<div class="k-stack">
          ${when(
            !datos.live,
            () =>
              html`<p class="k-notice k-notice--warn" role="status">
                WhatsApp real no está conectado: este servidor usa el canal simulado, así que no hay calidad, límite ni
                avisos de Meta que mostrar. Cuando se active la conexión con Meta, aquí se verá el estado de cada número.
              </p>`,
          )}
          ${when(datos.account, () => tarjetaCuenta(datos.account, ctx.uid))}
          ${when(
            datos.numbers.length,
            () => html`<div class="sal-numeros">${datos.numbers.map(numero => tarjetaNumero(numero, { puede }))}</div>`,
            () =>
              html`<div class="k-card">
                ${empty({
                  title: 'Todavía no hay números de WhatsApp',
                  text: 'Da de alta un número en Operación → Sistema → Conectores para ver aquí su estado.',
                })}
              </div>`,
          )}
          ${historial(datos.history, ctx.uid)}
        </div>`,
      );
    }

    async function cargar() {
      let datos;
      try {
        datos = await api.get('/api/whatsapp/health');
      } catch (error) {
        if (montado && !isAbort(error))
          render(
            ranura('cuerpo'),
            failure({ title: 'No se pudo consultar la salud del canal', error, retry: 'reintentar' }),
          );
        return;
      }
      if (montado) pintar(datos);
    }

    async function consultar(accountRef) {
      if (ocupado) return;
      ocupado = true;
      try {
        const datos = await api.post('/api/whatsapp/health/refresh', accountRef ? { accountRef } : {});
        ocupado = false;
        if (!montado) return;
        pintar(datos);
        ctx.toast(accountRef ? 'Número consultado en Meta.' : 'Se consultó a Meta.');
      } finally {
        ocupado = false;
      }
    }

    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            consultar: () => consultar(null),
            'consultar-numero': (_evento, boton) => consultar(boton.getAttribute('data-ref')),
          },
        },
        { onError: error => ctx.toast(error.message) },
      ),
    );
    // Un aviso en vivo pide los datos de nuevo una sola vez por tanda (llegan varios seguidos).
    enVivo = {
      cambio() {
        clearTimeout(espera);
        espera = setTimeout(cargar, 300);
      },
    };
    ctx.onUnmount(() => {
      montado = false;
      enVivo = null;
      clearTimeout(espera);
    });
    cargar();
  },

  onEvent(evento) {
    if (evento?.type === 'channel_health.changed') enVivo?.cambio();
  },
};
