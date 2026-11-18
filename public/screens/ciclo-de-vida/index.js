/**
 * Pantalla «Ciclo de conversaciones» (docs/PLAN_CICLO_DE_VIDA.md): los ajustes del ciclo de vida por marca.
 *
 * Una tarjeta por marca con tres ajustes: expiración automática (apagada por omisión), aviso cuando se pierde una
 * conversación y días de atribución a una campaña. Guarda con expectedRevision; si otra persona cambió la marca
 * mientras tanto, el servidor responde 409 y la tarjeta se recarga. Sólo administración (settings.inbox).
 */
import { attrs, html, render } from '../../kit/html.js';
import { listen } from '../../kit/events.js';
import { failure, loading } from '../../kit/components/feedback.js';

const card = s => {
  const name = s.brandName || s.brandId;
  const id = 'cv-' + s.brandId;
  return html`<form class="k-card cv-card" data-do="save" data-brand="${s.brandId}" data-revision="${s.revision}">
    <h2>${name}</h2>
    <label class="cv-row" for="${id + '-expire'}">
      <input type="checkbox" id="${id + '-expire'}" name="autoExpire" ${attrs({ checked: s.autoExpire })} />
      <span
        ><strong>Expirar a las 24 horas</strong>
        <small>Una conversación sin mensajes de la persona en 24 horas pasa a «Expirada». No se envía nada.</small></span
      >
    </label>
    <label class="cv-row" for="${id + '-missed'}">
      <input type="checkbox" id="${id + '-missed'}" name="missedNotify" ${attrs({ checked: s.missedNotify })} />
      <span
        ><strong>Avisar cuando se pierde una</strong>
        <small>Al responsable y a administración, si expiró sin respuesta.</small></span
      >
    </label>
    <label class="cv-days" for="${id + '-days'}"
      ><span>Días de atribución a una campaña</span>
      <input type="number" id="${id + '-days'}" name="attributionDays" min="1" max="30" value="${s.attributionDays}"
    /></label>
    <div class="cv-actions">
      <button class="k-btn k-btn--primary" type="submit" ${attrs({ disabled: !s.canEdit })}>Guardar</button>
    </div>
  </form>`;
};

export default {
  mount(root, ctx) {
    const api = ctx.api;
    async function load() {
      render(root, html`<section class="k-page cv-page">${loading('Cargando ajustes…')}</section>`);
      try {
        const list = await api.get('/api/lifecycle/settings');
        render(
          root,
          html`<section class="k-page cv-page">
            <header class="k-head">
              <div>
                <span class="k-eyebrow">Conversaciones</span>
                <h1>Ciclo de las conversaciones</h1>
                <p class="k-lead">
                  El estado de cada conversación (Abierta, Pendiente, Resuelta, Expirada) es aparte de quién la atiende.
                  Aquí decides, por marca, si las conversaciones expiran solas.
                </p>
              </div>
            </header>
            <div class="cv-grid">${list.settings.map(card)}</div>
          </section>`,
        );
      } catch (error) {
        render(root, html`<section class="k-page">${failure({ error, retry: load })}</section>`);
      }
    }
    const stop = listen(
      root,
      {
        submit: {
          async save(event, form, values) {
            try {
              await api.patch('/api/lifecycle/settings/' + form.dataset.brand, {
                expectedRevision: Number(form.dataset.revision),
                autoExpire: Boolean(values.autoExpire),
                missedNotify: Boolean(values.missedNotify),
                attributionDays: Number(values.attributionDays),
              });
              ctx.toast('Ajustes guardados.');
            } catch (error) {
              ctx.toast(error.message);
            }
            await load();
          },
        },
      },
      { onError: error => ctx.toast(error.message) },
    );
    if (typeof stop === 'function') ctx.onUnmount(stop);
    load();
  },
  // Los ajustes cambian poco y la tarjeta se recarga al guardar; un cambio de otra persona llega como 409.
  onEvent() {},
};
