/**
 * Asistente por pasos (importar contactos, crear una difusión).
 *
 * Por qué existe: un asistente tiene reglas que no dependen de su contenido y que conviene hacer una sola
 * vez: no se avanza sin validar el paso, se puede volver a cualquier paso ya hecho, lo escrito en un paso
 * no se pierde al ir y volver, quien usa lector de pantalla oye en qué paso está y, en celular, el paso
 * actual y «Siguiente» quedan siempre a mano.
 */
import { attrs, html, render, when } from '../html.js';
import { listen } from '../events.js';
import { nextId } from '../ids.js';
import { glyph } from '../glyphs.js';

const slotName = stepId => `paso-${stepId}`;

/**
 * @param {HTMLElement} root
 * @param {object} options
 * @param {Array<{id: string, title: string, hint?: string}>} options.steps
 * @param {(step: {id: string, title: string}, body: HTMLElement, first: boolean) => void} options.onEnter
 *   Se llama cada vez que un paso pasa a ser el actual. `body` es su ranura y se conserva al cambiar de
 *   paso: con `first` en true se monta; después basta con refrescar (el resumen final, por ejemplo).
 * @param {(step: {id: string}) => (true | string | Promise<true | string>)} [options.validate]
 *   Antes de avanzar: true deja pasar; un texto se muestra como el motivo por el que no se puede.
 * @param {() => (void | Promise<void>)} options.onFinish Al pulsar el botón del último paso.
 * @param {string} [options.label] Nombre del asistente para lectores de pantalla.
 * @param {string} [options.current] Paso inicial (por ejemplo, el guardado en ctx.keep).
 * @param {(stepId: string) => void} [options.onStep] Aviso de cambio de paso, para guardarlo.
 * @param {string} [options.finishLabel]
 * @param {unknown} [options.extra] Fragmento con botones propios para el pie («Guardar borrador»).
 */
export function wizard(
  root,
  { steps, onEnter, validate, onFinish, onStep, label = 'Pasos', current: initial, finishLabel = 'Terminar', extra },
) {
  const id = nextId('asistente');
  let index = Math.max(
    0,
    steps.findIndex(step => step.id === initial),
  );
  let reached = index; // el paso más avanzado al que se llegó: hasta ahí se puede saltar
  let problem = '';
  let busy = false;
  const entered = new Set();

  const slot = stepId => root.querySelector(`[data-slot="${slotName(stepId)}"]`);

  function draw() {
    const step = steps[index];
    const last = index === steps.length - 1;
    render(
      root,
      html`<div class="k-wizard">
        <nav class="k-wizard__nav" aria-label="${label}">
          <ol class="k-steps">
            ${steps.map((item, i) => {
              const done = i < reached && i !== index;
              return html`<li class="${['k-step', i === index && 'is-current', done && 'is-done']}" data-key="${slotName(item.id)}">
                <button
                  type="button"
                  class="k-step__btn"
                  data-do="k-wz-go"
                  data-index="${i}"
                  aria-current="${i === index ? 'step' : 'false'}"
                  ${attrs({ disabled: i > reached })}
                >
                  <span class="k-step__n">${done ? glyph('check') : i + 1}</span>
                  <span class="k-step__t">${item.title}</span>
                  ${when(done, () => html`<span class="k-sr">(completo)</span>`)}
                </button>
              </li>`;
            })}
          </ol>
        </nav>
        <p class="k-wizard__where">Paso ${index + 1} de ${steps.length}</p>
        <section class="k-wizard__body" aria-labelledby="${id}-titulo">
          <h2 class="k-wizard__title" id="${id}-titulo" tabindex="-1">${step.title}</h2>
          ${when(step.hint, () => html`<p class="k-hint">${step.hint}</p>`)} ${steps.map(item => html`<div data-slot="${slotName(item.id)}"></div>`)}
          ${when(problem, () => html`<p class="k-error" role="alert">${problem}</p>`)}
        </section>
        <footer class="k-wizard__foot">
          ${when(extra, () => html`<div class="k-wizard__extra k-row">${extra}</div>`)}
          ${when(index > 0, () => html`<button type="button" class="k-btn" data-do="k-wz-back">Atrás</button>`)}
          <button type="button" class="k-btn k-btn--primary" data-do="k-wz-next" aria-disabled="${busy}">${last ? finishLabel : 'Siguiente'}</button>
        </footer>
      </div>`,
    );
    // Las ranuras de los pasos son de la pantalla (render() no las toca); aquí sólo se decide cuál se ve.
    for (const item of steps) slot(item.id).hidden = item.id !== step.id;
  }

  function enter({ focus }) {
    const step = steps[index];
    const first = !entered.has(step.id);
    entered.add(step.id);
    onEnter(step, slot(step.id), first);
    // El foco va al título del paso: quien no ve la pantalla oye dónde está.
    if (focus) root.querySelector(`[id="${id}-titulo"]`)?.focus();
  }

  function goTo(next) {
    if (next < 0 || next >= steps.length || next > reached || next === index) return;
    index = next;
    problem = '';
    draw();
    enter({ focus: true });
    onStep?.(steps[index].id);
  }

  async function forward() {
    if (busy) return;
    busy = true;
    problem = '';
    draw();
    const last = index === steps.length - 1;
    let verdict;
    try {
      verdict = validate ? await validate(steps[index]) : true;
      if (verdict === true && last) await onFinish();
    } catch (error) {
      console.error(error);
      verdict = error?.name === 'ApiError' ? error.message : 'No se pudo continuar. Vuelve a intentarlo.';
    }
    busy = false;
    if (verdict !== true)
      problem = typeof verdict === 'string' && verdict ? verdict : 'Revisa este paso antes de continuar.';
    if (verdict !== true || last) {
      draw();
      return;
    }
    reached = Math.max(reached, index + 1);
    goTo(index + 1);
  }

  const off = listen(
    root,
    {
      click: {
        'k-wz-go': (_event, button) => goTo(Number(button.getAttribute('data-index'))),
        'k-wz-back': () => goTo(index - 1),
        'k-wz-next': forward,
      },
    },
    { contain: false },
  );

  draw();
  enter({ focus: false });

  return {
    current: () => steps[index].id,
    /** La ranura de un paso (por omisión, el actual). */
    body: stepId => slot(stepId ?? steps[index].id),
    /** Avanza validando, igual que el botón «Siguiente». */
    next: forward,
    back: () => goTo(index - 1),
    /** Muestra un motivo por el que no se puede seguir (por ejemplo, un error del servidor). */
    setProblem(text) {
      problem = text;
      draw();
    },
    destroy: off,
  };
}
