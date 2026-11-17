/**
 * Pantalla «Cambio de número» (I-11, docs/PLAN_CAMBIO_DE_NUMERO.md): una tarjeta por número de WhatsApp con su modo
 * (activo o escucha), los contadores de la escucha para compararlos con el proveedor anterior, la lista de prueba y
 * las acciones del corte: «Pasar a activo», «Abrir conversaciones recientes» (con su vista previa), «Volver a
 * escucha» y «Registrar número». Cada acción delicada pide escribir una palabra y enumera sus consecuencias.
 * Los datos salen de GET /api/whatsapp/cutover; el servidor decide qué números ve cada quien.
 * El PIN sólo pasa por la ventana y la petición: no se guarda en la pantalla.
 */
import { html, render, when } from '../../kit/html.js';
import { formValues, listen } from '../../kit/events.js';
import { isAbort, newClientRef } from '../../kit/api.js';
import { dialog } from '../../kit/components/dialog.js';
import { nextId } from '../../kit/ids.js';
import { empty, failure, loading } from '../../kit/components/feedback.js';

const FECHA = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' });
const fecha = instante => (instante ? FECHA.format(new Date(instante)) : 'Nunca');
const DIA = new Intl.DateTimeFormat('es-MX', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dia = texto => DIA.format(new Date(texto + 'T12:00:00Z'));
const ACCION = {
  listen: 'Pasó a escucha',
  live: 'Pasó a activo',
  open_recent: 'Conversaciones recientes abiertas',
  register: 'Número registrado en Meta',
};
const telefono = clave => '+' + clave;

/** Un contador de la tarjeta: rótulo y cifra grande en un bloque de color. */
const cifra = (rotulo, valor, tono) =>
  html`<div class="k-figure" data-tone="${tono}">
    <dt class="k-figure__label">${rotulo}</dt>
    <dd class="k-figure__value">${String(valor)}</dd>
  </div>`;
/** Un dato de la tarjeta en su pieza. */
const dato = (rotulo, valor) =>
  html`<div class="k-piece">
    <dt class="k-piece__label">${rotulo}</dt>
    <dd class="k-piece__value">${valor}</dd>
  </div>`;

function tarjeta(numero, uid) {
  const escucha = numero.mode === 'listen';
  const hoy = numero.listen.days[0];
  const listo = escucha && numero.daysListening >= 3 && numero.listen.quarantine === 0;
  return html`<article class="k-card cn-numero" data-key="${numero.id}" aria-labelledby="${uid('n-' + numero.id)}">
    <div class="cn-titulo">
      <h2 id="${uid('n-' + numero.id)}">${numero.label}</h2>
      <span class="k-muted">${numero.brandName}</span>
    </div>
    <div class="k-row">
      <span class="${['k-chip', 'k-chip--lg', escucha ? 'k-chip--sky' : 'k-chip--ok']}">${escucha ? 'En escucha' : 'Activo'}</span>
      ${when(!numero.enabled, () => html`<span class="k-chip k-chip--lg k-chip--warn">En pausa en el CRM</span>`)}
      ${when(
        escucha,
        () =>
          html`<span class="${['k-chip', 'k-chip--lg', listo ? 'k-chip--ok' : 'k-chip--accent']}">
            ${listo ? 'Tres días de escucha sin pendientes' : 'Escucha en curso'}
          </span>`,
      )}
    </div>
    <p class="k-hint">
      ${
        escucha
          ? 'El proveedor anterior sigue atendiendo. El CRM identifica y cuenta los mensajes, pero no guarda su texto, no abre conversaciones, no responde y no envía nada, salvo a la lista de prueba.'
          : 'El CRM atiende este número: guarda las conversaciones, el asistente responde según la marca y todo lo que el equipo envía sale.'
      }
    </p>
    <dl class="cn-cifras">
      ${when(escucha, () => cifra('Días completos en escucha', numero.daysListening, 'sky'))}
      ${cifra('Conversaciones abiertas', numero.openConversations, 'lime')}
      ${cifra('En cuarentena ahora', numero.listen.quarantine, numero.listen.quarantine ? 'butter' : 'mint')}
    </dl>
    <dl class="cn-datos">
      ${dato('En este modo desde', fecha(numero.modeChangedAt))}
      ${dato('Registrado en Meta', fecha(numero.registeredAt))}
      ${dato('Vuelta atrás ensayada', numero.rollbackRehearsedAt ? fecha(numero.rollbackRehearsedAt) : 'Todavía no')}
      ${dato('Lista de prueba', numero.listenAllow.length ? numero.listenAllow.map(telefono).join(', ') : 'Sin teléfonos')}
    </dl>
    <div class="k-data__wrap" tabindex="0" role="region" aria-label="${'Escucha de ' + numero.label + ' por día'}">
      <table class="k-data">
        <caption>
          Mensajes por día (hora del centro de México). Hoy: ${String(hoy.received)} recibidos de ${String(hoy.people)}
          personas.
        </caption>
        <thead>
          <tr>
            <th scope="col">Día</th>
            <th scope="col">Recibidos</th>
            <th scope="col">Personas</th>
            <th scope="col">Sin identidad</th>
            <th scope="col">Estados ajenos</th>
            <th scope="col">Errores</th>
          </tr>
        </thead>
        <tbody>
          ${numero.listen.days.map(
            d => html`<tr data-key="${d.day}">
              <th scope="row">${dia(d.day)}</th>
              <td>${String(d.received)}</td>
              <td>${String(d.people)}</td>
              <td>${String(d.unidentified)}</td>
              <td>${String(d.statuses)}</td>
              <td>${String(d.errors)}</td>
            </tr>`,
          )}
        </tbody>
      </table>
    </div>
    <div class="k-actions">
      ${
        escucha
          ? html`<button type="button" class="k-btn k-btn--primary" data-do="activar" data-id="${numero.id}">Pasar a activo</button>
            <button type="button" class="k-btn" data-do="lista" data-id="${numero.id}">Lista de prueba</button>`
          : html`<button type="button" class="k-btn k-btn--primary" data-do="recientes" data-id="${numero.id}">
              Abrir conversaciones recientes
            </button>
            <button type="button" class="k-btn" data-do="escuchar" data-id="${numero.id}">Volver a escucha</button>`
      }
      <button type="button" class="k-btn" data-do="registrar" data-id="${numero.id}">Registrar número</button>
    </div>
    ${when(
      numero.history.length,
      () =>
        html`<ul class="cn-historial" aria-label="${'Historial de ' + numero.label}">
          ${numero.history.map(
            h => html`<li data-key="${String(h.seq)}">
              <span>${ACCION[h.action] ?? h.action}${h.detail ? ' · ' + h.detail : ''}</span>
              <span class="k-muted">${fecha(h.at)}${h.actor ? ' · ' + h.actor : ''}</span>
            </li>`,
          )}
        </ul>`,
    )}
  </article>`;
}

/**
 * Confirmación escrita: enumera las consecuencias y pide escribir `palabra` (y, si `pin`, el PIN de seis dígitos).
 * Devuelve {pin?} al confirmar o null.
 */
function confirmar({ titulo, consecuencias, palabra, boton, peligro = false, pin = false, extra = null }) {
  return dialog({
    title: titulo,
    mount(cuerpo, cerrar) {
      const idPalabra = nextId('palabra');
      const idPin = nextId('pin');
      render(
        cuerpo,
        html`<form class="k-stack" data-do="confirmar" novalidate>
          <ul class="cn-consecuencias">
            ${consecuencias.map(texto => html`<li>${texto}</li>`)}
          </ul>
          ${when(extra, () => extra)}
          ${when(
            pin,
            () =>
              html`<div class="k-field">
                <label class="k-label" for="${idPin}">PIN de verificación en dos pasos (seis dígitos)</label>
                <input class="k-input" id="${idPin}" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="6" />
              </div>`,
          )}
          <div class="k-field">
            <label class="k-label" for="${idPalabra}">Escribe ${palabra} para confirmar</label>
            <input class="k-input" id="${idPalabra}" name="palabra" autocomplete="off" />
          </div>
          <p class="k-error" role="alert" data-slot="error"></p>
          <div class="k-actions">
            <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
            <button type="submit" class="${['k-btn', peligro ? 'k-btn--danger' : 'k-btn--primary']}">${boton}</button>
          </div>
        </form>`,
      );
      const error = texto => render(cuerpo.querySelector('[data-slot="error"]'), html`${texto}`);
      return listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        submit: {
          confirmar: (evento, formulario) => {
            evento.preventDefault();
            const valores = formValues(formulario);
            if (
              String(valores.palabra || '')
                .trim()
                .toUpperCase() !== palabra
            )
              return error(`Escribe ${palabra} tal cual para confirmar.`);
            if (pin && !/^\d{6}$/.test(String(valores.pin || ''))) return error('El PIN son seis dígitos.');
            cerrar(pin ? { pin: valores.pin } : {});
          },
        },
      });
    },
  });
}

/** Ventana para editar la lista de prueba: un teléfono por renglón, con lada de país. */
function editarLista(numero) {
  return dialog({
    title: 'Lista de prueba',
    mount(cuerpo, cerrar) {
      const idLista = nextId('lista');
      render(
        cuerpo,
        html`<form class="k-stack" data-do="guardar" novalidate>
          <p>
            Hasta diez teléfonos del equipo. Mientras el número está en escucha, sólo a ellos se les puede escribir desde el
            CRM, y sus mensajes entran como una conversación normal para ensayar.
          </p>
          <div class="k-field">
            <label class="k-label" for="${idLista}">Teléfonos, uno por renglón</label>
            <textarea class="k-input" id="${idLista}" name="lista" rows="5">${numero.listenAllow.map(telefono).join('\n')}</textarea>
          </div>
          <div class="k-actions">
            <button type="button" class="k-btn" data-do="cancelar">Cancelar</button>
            <button type="submit" class="k-btn k-btn--primary">Guardar lista</button>
          </div>
        </form>`,
      );
      return listen(cuerpo, {
        click: { cancelar: () => cerrar(null) },
        submit: {
          guardar: (evento, formulario) => {
            evento.preventDefault();
            const lista = String(formValues(formulario).lista || '')
              .split('\n')
              .map(linea => linea.trim())
              .filter(Boolean);
            cerrar({ lista });
          },
        },
      });
    },
  });
}

let enVivo = null;

export default {
  mount(root, ctx) {
    const api = ctx.api;
    let montado = true;
    let datos = null;
    let espera = 0;

    render(
      root,
      html`<section class="k-page">
        <header class="k-head">
          <div>
            <span class="k-eyebrow">WhatsApp</span>
            <h1>Cambio de número</h1>
            <p class="k-lead">
              Mudar el número real al CRM sin un corte a ciegas: escuchar unos días mientras el proveedor anterior atiende,
              pasar a activo, abrir las conversaciones recientes y registrar el número en Meta.
            </p>
          </div>
        </header>
        <div data-slot="cuerpo"></div>
      </section>`,
    );
    const cuerpo = root.querySelector('[data-slot="cuerpo"]');
    render(cuerpo, loading('Consultando los números…'));

    function pintar() {
      render(
        cuerpo,
        html`<div class="k-stack">
          ${when(
            !datos.live,
            () =>
              html`<p class="k-notice k-notice--warn" role="status">
                WhatsApp real no está conectado: este servidor usa el canal simulado. Los modos y las conversaciones
                recientes funcionan igual, y «Registrar número» responde sin llamar a Meta.
              </p>`,
          )}
          ${when(
            datos.numbers.length,
            () => html`<div class="cn-numeros">${datos.numbers.map(numero => tarjeta(numero, ctx.uid))}</div>`,
            () =>
              html`<div class="k-card">
                ${empty({
                  title: 'Todavía no hay números de WhatsApp',
                  text: 'Da de alta un número en Operación → Sistema → Conectores para prepararlo aquí.',
                })}
              </div>`,
          )}
        </div>`,
      );
    }

    async function cargar() {
      try {
        datos = await api.get('/api/whatsapp/cutover');
      } catch (error) {
        if (montado && !isAbort(error))
          render(cuerpo, failure({ title: 'No se pudieron consultar los números', error, retry: 'reintentar' }));
        return;
      }
      if (montado) pintar();
    }

    const numeroDe = boton => datos?.numbers.find(n => n.id === boton.getAttribute('data-id'));
    const ruta = (numero, accion) => `/api/whatsapp/numbers/${numero.id}/${accion}`;
    const cambiarModo = (numero, cambios) =>
      api.post(ruta(numero, 'mode'), {
        mode: numero.mode,
        ...cambios,
        expectedRevision: numero.revision,
        clientRef: newClientRef(),
      });

    async function activar(numero) {
      const ok = await confirmar({
        titulo: `Pasar ${numero.label} a activo`,
        palabra: 'ACTIVAR',
        boton: 'Pasar a activo',
        consecuencias: [
          'Desde ese momento el CRM guarda las conversaciones de este número y el asistente responde según la marca.',
          'Todo lo que el equipo, el asistente, las difusiones y los programados envíen saldrá por este número.',
          'Antes, apaga en el proveedor anterior las reglas, los bots y las campañas: si los dos responden, la persona recibe dos respuestas.',
          'Después, usa «Abrir conversaciones recientes» para que nadie que escribió en las últimas horas quede sin atender.',
        ],
      });
      if (!ok) return;
      await cambiarModo(numero, { mode: 'live' });
      ctx.toast('El número está activo en el CRM.');
      await cargar();
    }

    async function escuchar(numero) {
      const ok = await confirmar({
        titulo: `Volver ${numero.label} a escucha`,
        palabra: 'ESCUCHA',
        boton: 'Volver a escucha',
        peligro: true,
        consecuencias: [
          'Es la vuelta atrás: el CRM deja de enviar por este número (salvo a la lista de prueba) y deja de guardar lo que llega.',
          `Lo que esté por salir en las ${numero.openConversations} conversaciones abiertas quedará como no entregado, con su motivo.`,
          'Vuelve a encender en el proveedor anterior sus reglas y bots para que atienda.',
        ],
      });
      if (!ok) return;
      await cambiarModo(numero, { mode: 'listen' });
      ctx.toast('El número volvió a escucha.');
      await cargar();
    }

    async function lista(numero) {
      const out = await editarLista(numero);
      if (!out) return;
      await cambiarModo(numero, { listenAllow: out.lista });
      ctx.toast('Lista de prueba guardada.');
      await cargar();
    }

    async function recientes(numero) {
      const horas = datos.maxHours;
      const vista = await api.post(ruta(numero, 'open-recent'), { hours: horas, preview: true });
      const ok = await confirmar({
        titulo: 'Abrir conversaciones recientes',
        palabra: 'ABRIR',
        boton: `Abrir ${vista.toOpen}`,
        consecuencias: [
          `Escribieron en las últimas ${horas} horas: ${vista.eligible} personas. ${vista.existing} ya tienen conversación con este número${vista.skipped ? ` y ${vista.skipped} tienen otra abierta del mismo curso` : ''}.`,
          `Se abrirán ${vista.toOpen} conversaciones en espera de una persona, con el asistente apagado.`,
          'No se envía nada: el equipo contesta desde la bandeja. Repetirlo no duplica.',
        ],
      });
      if (!ok) return;
      const hecho = await api.post(ruta(numero, 'open-recent'), { hours: horas });
      ctx.toast(`Se abrieron ${hecho.opened} conversaciones.`);
      await cargar();
    }

    async function registrar(numero) {
      const ok = await confirmar({
        titulo: `Registrar ${numero.label} en Meta`,
        palabra: 'REGISTRAR',
        boton: 'Registrar número',
        peligro: true,
        pin: true,
        consecuencias: [
          'Es el corte: Meta registra el número en la cuenta de WhatsApp Business conectada al CRM.',
          'El PIN de verificación en dos pasos viaja a Meta y no se guarda en ningún lado.',
          'Meta admite pocos intentos: el CRM permite tres por hora para este número.',
        ],
      });
      if (!ok) return;
      const out = await api.post(ruta(numero, 'register'), { pin: ok.pin });
      ctx.toast(out.simulated ? 'Registro simulado: no se llamó a Meta.' : 'Meta registró el número.');
      await cargar();
    }

    const con = accion => (_evento, boton) => {
      const numero = numeroDe(boton);
      return numero ? accion(numero) : undefined;
    };
    ctx.onUnmount(
      listen(
        root,
        {
          click: {
            reintentar: cargar,
            activar: con(activar),
            escuchar: con(escuchar),
            lista: con(lista),
            recientes: con(recientes),
            registrar: con(registrar),
          },
        },
        {
          onError: error => {
            ctx.toast(error.message);
            cargar();
          },
        },
      ),
    );
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
    if (evento?.type === 'wa_cutover.changed') enVivo?.cambio();
  },
};
