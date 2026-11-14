/**
 * Gráficas propias en SVG, sin biblioteca.
 *
 * Por qué propias: la política de contenido sólo deja cargar guiones del mismo origen, las formas que
 * hacen falta son pocas, y así el mismo dato produce a la vez la gráfica y su tabla. Cada función es pura:
 * recibe datos y devuelve texto; escapa ella misma todo lo que escribe y nunca acepta HTML.
 *
 * Lo que devuelve cada gráfica:
 *   { html, svg, table, label }
 *   - html:  fragmento listo para html`…` (el SVG y, si hay varias series, su leyenda).
 *   - svg:   el SVG como texto (para pruebas o para exportarlo).
 *   - table: la tabla gemela, como fragmento. TODA gráfica tiene una: un globo o un color nunca son la
 *            única forma de leer un valor. figure() la pone detrás de «Ver tabla».
 *   - label: el resumen que se lee en voz alta (el aria-label del SVG).
 *
 * Reglas que este archivo garantiza y test/kit-charts.test.mjs vigila:
 * - Nunca sale NaN ni Infinity: sin datos, con un solo punto o con todo en cero, la gráfica se pinta.
 * - Un SVG no se escala: mide en píxeles lo que dice `width`. Así la letra es siempre de 11 px; si no
 *   cabe, se desplaza dentro de su caja. Para que se ajuste al ancho disponible está responsive().
 * - Ningún rótulo se sale: el ancho del texto se calcula por exceso y lo que no cabe se recorta con «…»
 *   o no se pinta (el dato sigue en la tabla).
 * - Sin colores escritos aquí: las clases k-ch-… toman los suyos de public/tokens.css. El texto nunca
 *   lleva el color de la serie. Sin animaciones.
 * - Las cantidades negativas o no numéricas cuentan como 0: son gráficas de conteos e importes.
 */
import { esc, isSafe, raw, url } from './html.js';
import { glyphMarkup } from './glyphs.js';

// ---------------------------------------------------------------------------------------------------
// Números y texto
// ---------------------------------------------------------------------------------------------------

const NUMBER = new Intl.NumberFormat('es-MX', { maximumFractionDigits: 1 });

/** Formato por omisión: cifras con separador de miles y como mucho un decimal. */
export const formatNumber = value => NUMBER.format(value);

/** Porcentaje a partir de una fracción: 0.124 → «12.4 %». */
export const formatPercent = fraction => `${NUMBER.format(Math.round(toNumber(fraction) * 1000) / 10)} %`;

/** Cualquier cosa a una cantidad válida: lo no numérico y lo negativo cuentan como 0. */
function toNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Coordenada para el SVG: dos decimales como mucho y nunca NaN. */
function px(value) {
  return Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0';
}

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sum = values => values.reduce((total, value) => total + value, 0);

const FONT = 11;

// Ancho de cada carácter como fracción del tamaño de letra. Son COTAS SUPERIORES: se midieron en un
// navegador con la tipografía de la aplicación (Manrope, pesos 400 y 600, cifras tabulares) el 13 nov 2026,
// carácter por carácter, y cada grupo lleva el ancho del más ancho de los suyos. Si cambia la tipografía
// hay que volver a medir.
const SLIM = new Set("iljfI.,:;|!'· "); // hasta 0.36
const HALF = new Set('rt()[]'); // hasta 0.46
const BROAD = new Set('=&_…'); // hasta 0.76, como las mayúsculas
const WIDE = new Set('mwMW@%#—'); // hasta 0.98

function charWidth(ch) {
  if (SLIM.has(ch)) return 0.36;
  if (HALF.has(ch)) return 0.46;
  if (WIDE.has(ch)) return 0.98;
  if (BROAD.has(ch)) return 0.76;
  if (ch.codePointAt(0) >= 0x2e80) return 1.1; // ideogramas y emojis ocupan un cuadro entero
  if (ch !== ch.toLowerCase() && ch === ch.toUpperCase()) return 0.76; // mayúsculas
  return 0.64; // minúsculas, cifras y el resto de los signos
}

/**
 * Ancho, en píxeles, que como mucho ocupa un texto a 11 px. Sin DOM no se puede medir, así que se calcula
 * por exceso: es preferible recortar un rótulo de más que dejar que se salga.
 */
export function textWidth(text) {
  let units = 0;
  for (const ch of String(text)) units += charWidth(ch);
  return units * FONT;
}

/** Recorta un texto con «…» para que quepa en `max` píxeles. */
export function fitText(text, max) {
  const full = String(text);
  if (textWidth(full) <= max) return full;
  const room = max - textWidth('…');
  let out = '';
  for (const ch of full) {
    if (textWidth(out + ch) > room) break;
    out += ch;
  }
  return out.trimEnd() ? `${out.trimEnd()}…` : '';
}

/**
 * Marcas «redondas» de un eje que empieza en 0: pasos de 1, 2, 2.5 o 5 por una potencia de diez.
 * La última marca es el tope de la escala. Con datos enteros no propone medias unidades.
 */
export function niceTicks(max, { count = 4, integer = false } = {}) {
  const top = toNumber(max) || 1;
  const rough = top / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const unit = rough / power;
  let step = (unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10) * power;
  if (integer) step = Math.max(1, Math.ceil(step));
  const steps = Math.max(1, Math.ceil(top / step - 1e-9));
  return Array.from({ length: steps + 1 }, (_, index) => Number((index * step).toPrecision(12)));
}

// ---------------------------------------------------------------------------------------------------
// Piezas de SVG
// ---------------------------------------------------------------------------------------------------

/** Atributos a partir de un objeto: los números pasan por px() y los textos se escapan. */
function attributes(map) {
  let out = '';
  for (const [name, value] of Object.entries(map)) {
    if (value === null || value === undefined || value === false) continue;
    out += ` ${name}="${typeof value === 'number' ? px(value) : esc(value)}"`;
  }
  return out;
}

const element = (name, map, content) =>
  content === undefined ? `<${name}${attributes(map)}/>` : `<${name}${attributes(map)}>${content}</${name}>`;
const text = (map, content) => element('text', map, esc(content));
const title = content => `<title>${esc(content)}</title>`;

/** Barra con el extremo redondeado: arriba ('top') o a la derecha ('right'). */
function bar(x, y, width, height, side, map) {
  const radius = Math.min(4, side === 'top' ? width / 2 : height / 2, side === 'top' ? height : width);
  if (radius < 1) return element('rect', { ...map, x, y, width: Math.max(0, width), height: Math.max(0, height) });
  const [right, bottom] = [x + width, y + height];
  const d =
    side === 'top'
      ? `M${px(x)} ${px(bottom)}V${px(y + radius)}Q${px(x)} ${px(y)} ${px(x + radius)} ${px(y)}H${px(right - radius)}Q${px(right)} ${px(y)} ${px(right)} ${px(y + radius)}V${px(bottom)}Z`
      : `M${px(x)} ${px(y)}H${px(right - radius)}Q${px(right)} ${px(y)} ${px(right)} ${px(y + radius)}V${px(bottom - radius)}Q${px(right)} ${px(bottom)} ${px(right - radius)} ${px(bottom)}H${px(x)}Z`;
  return element('path', { ...map, d });
}

/**
 * El <svg> raíz. `focusable` lo hace una parada de tabulación para recorrer sus puntos con las flechas
 * (ver bind()).
 */
function svgRoot({ kind, width, height, label, focusable = false }, content) {
  return element(
    'svg',
    {
      class: 'k-ch',
      xmlns: 'http://www.w3.org/2000/svg',
      width,
      height,
      viewBox: `0 0 ${px(width)} ${px(height)}`,
      role: 'img',
      'aria-label': label,
      'data-k-chart': kind,
      tabindex: focusable ? '0' : null,
    },
    content,
  );
}

const cell = (value, format) =>
  typeof value === 'number' ? { text: format(value), numeric: true } : { text: String(value ?? ''), numeric: false };

function tableMarkup({ caption, head, rows }, format = formatNumber) {
  const columns = head.length;
  const body = rows.length
    ? rows
        .map(row => {
          const cells = row.map((value, index) => {
            const { text: content, numeric } = cell(value, format);
            return index === 0
              ? `<th scope="row">${esc(content)}</th>`
              : `<td${numeric ? ' class="k-num"' : ''}>${esc(content)}</td>`;
          });
          return `<tr>${cells.join('')}</tr>`;
        })
        .join('')
    : `<tr><td colspan="${columns}">Sin datos</td></tr>`;
  const numericColumn = index => rows.length > 0 && rows.every(row => typeof row[index] === 'number');
  const header = head
    .map((name, index) => `<th scope="col"${numericColumn(index) ? ' class="k-num"' : ''}>${esc(name)}</th>`)
    .join('');
  return `<table class="k-data"><caption>${esc(caption)}</caption><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * Tabla accesible con título y cabeceras. Es también la gemela de cada gráfica.
 * Los números se alinean a la derecha y se formatean; la primera celda de cada fila es su cabecera.
 * @param {{caption: string, head: string[], rows: Array<Array<string | number>>, format?: (value: number) => string}} data
 */
export function table({ caption, head, rows, format = formatNumber }) {
  return raw(tableMarkup({ caption, head, rows }, format));
}

const result = ({ svg, markup = svg, twin, label }) =>
  Object.freeze({ html: raw(markup), svg, table: raw(twin), label });

function legendMarkup(items) {
  return `<ul class="k-legend">${items.map(item => `<li><span class="k-legend__key ${item.key}"></span>${esc(item.text)}</li>`).join('')}</ul>`;
}

/** Gráfica sin datos: mismo tamaño, una frase y una tabla que también lo dice. */
function nothing({ kind, width, height, label, head }) {
  const svg = svgRoot(
    { kind, width, height, label: `${label}: sin datos` },
    element('rect', { class: 'k-ch-track', x: 0, y: 0, width, height, rx: 6 }) +
      text({ x: width / 2, y: height / 2 + 4, 'text-anchor': 'middle' }, fitText('Sin datos', width - 8)),
  );
  return result({
    svg,
    markup: `<div class="k-chart">${svg}</div>`,
    twin: tableMarkup({ caption: label, head, rows: [] }),
    label: `${label}: sin datos`,
  });
}

/**
 * Series con forma conocida. Acepta una lista de números (una sola serie) o [{name, values, color}].
 * Con una sola serie el color es el acento; con varias, cada una dice su número de 1 a 6 (el color sigue
 * a la entidad, no al orden) o toma el de su posición.
 */
function seriesOf(input) {
  const list =
    Array.isArray(input) && input.every(item => typeof item !== 'object' || item === null)
      ? [{ name: '', values: input }]
      : Array.isArray(input)
        ? input
        : [];
  return list.slice(0, 6).map((item, index, all) => ({
    name: String(item?.name ?? ''),
    values: Array.from(item?.values ?? [], toNumber),
    key: `k-ch-s${all.length === 1 && !item?.color ? 7 : clamp(Math.trunc(toNumber(item?.color)) || index + 1, 1, 7)}`,
  }));
}

/** Qué rótulos del eje horizontal caben sin pisarse; en pantallas estrechas: primero, medio y último. */
function pickLabels(labels, positions, { left, right, narrow }) {
  const count = labels.length;
  if (!count) return [];
  const widest = Math.max(...labels.map(textWidth));
  const span = count > 1 ? Math.abs(positions[count - 1] - positions[0]) / (count - 1) : right - left;
  let every = Math.max(1, Math.ceil((widest + 12) / Math.max(span, 0.01)));
  let wanted = [];
  for (let index = 0; index < count; index += every) wanted.push(index);
  if (narrow && count > 3) wanted = [0, Math.floor((count - 1) / 2), count - 1];
  else if (wanted[wanted.length - 1] !== count - 1) {
    // El último siempre se rotula; si queda pegado al anterior, se quita el anterior.
    if (wanted.length > 1 && (count - 1 - wanted[wanted.length - 1]) * span < widest + 12) wanted.pop();
    wanted.push(count - 1);
  }
  const placed = [];
  let edge = -Infinity;
  for (const index of [...new Set(wanted)]) {
    const content = fitText(labels[index], right - left);
    const width = textWidth(content);
    const start = clamp(positions[index] - width / 2, left, Math.max(left, right - width));
    if (start < edge + 6) continue;
    edge = start + width;
    placed.push({ index, content, x: start });
  }
  return placed;
}

/** Eje vertical: líneas de rejilla continuas y sus cifras, a la izquierda. */
function gridMarkup(ticks, { left, right, y, format }) {
  return ticks
    .map(
      tick =>
        element('line', { class: 'k-ch-grid', x1: left, x2: right, y1: y(tick), y2: y(tick) }) +
        text({ x: left - 6, y: y(tick) + 4, 'text-anchor': 'end' }, format(tick)),
    )
    .join('');
}

const labelsFor = (labels, count) => Array.from({ length: count }, (_, index) => String(labels[index] ?? index + 1));
const allIntegers = lists => lists.every(values => values.every(Number.isInteger));

// ---------------------------------------------------------------------------------------------------
// Línea y chispa
// ---------------------------------------------------------------------------------------------------

/** Separa en vertical los rótulos de punta que se pisan. Devuelve false si no caben todos. */
function spread(items, gap, low, high) {
  items.sort((a, b) => a.y - b.y);
  for (let index = 1; index < items.length; index++)
    items[index].y = Math.max(items[index].y, items[index - 1].y + gap);
  if (items.length && items[items.length - 1].y > high) {
    items[items.length - 1].y = high;
    for (let index = items.length - 2; index >= 0; index--)
      items[index].y = Math.min(items[index].y, items[index + 1].y - gap);
  }
  return items.every(item => item.y >= low);
}

/**
 * Tendencia en el tiempo. Línea de 2 px con el último punto marcado; el periodo anterior, en gris.
 * Con dos a cuatro series, cada línea lleva además su nombre en la punta. Al pasar el cursor por una
 * franja (o recorrerla con las flechas tras bind()) aparecen los puntos y su valor.
 *
 * @param {object} data
 * @param {string[]} data.labels Rótulos del eje horizontal, uno por punto.
 * @param {number[] | Array<{name: string, values: number[], color?: number}>} data.series
 * @param {number[]} [data.previous] Los valores del periodo anterior, para comparar.
 * @param {string} [data.label] De qué es la gráfica (empieza el resumen leído y titula la tabla).
 * @param {string} [data.summary] Resumen propio, si el calculado (total y máximo) no aplica al dato.
 * @param {string} [data.axis] Cabecera de la primera columna de la tabla.
 * @param {(value: number) => string} [data.format]
 * @param {number} [data.width] Ancho en píxeles (por omisión 640).
 * @param {number} [data.height]
 */
export function line({
  labels = [],
  series,
  previous,
  label = 'Tendencia',
  summary,
  axis = 'Periodo',
  format = formatNumber,
  width = 640,
  height = 220,
} = {}) {
  const list = seriesOf(series);
  const before = previous ? Array.from(previous, toNumber) : null;
  const count = Math.max(labels.length, ...list.map(item => item.values.length), 0);
  const W = clamp(toNumber(width) || 640, 160, 4000);
  const H = clamp(toNumber(height) || 220, 120, 2000);
  const names = list.map(item => item.name || 'Valor');
  const head = [axis, ...names, ...(before ? ['Periodo anterior'] : [])];
  if (!count || !list.length) return nothing({ kind: 'line', width: W, height: H, label, head });

  const marks = labelsFor(labels, count);
  const top = Math.max(...list.flatMap(item => item.values), ...(before ?? []), 0);
  const ticks = niceTicks(top, {
    count: H < 180 ? 3 : 4,
    integer: allIntegers([...list.map(item => item.values), before ?? []]),
  });
  const max = ticks[ticks.length - 1];
  const narrow = W < 420;
  const tipped = !narrow && list.length >= 2 && list.length <= 4;
  const tipWidth = tipped ? Math.min(Math.max(...names.map(textWidth)), W * 0.26) : 0;
  const left = Math.max(...ticks.map(tick => textWidth(format(tick)))) + 10;
  const right = W - (tipped ? tipWidth + 16 : 12);
  const [y0, y1] = [12, H - 26];
  const plot = Math.max(right - left, 10);
  const x = index => left + (count === 1 ? plot / 2 : (plot * index) / (count - 1));
  const y = value => y1 - ((y1 - y0) * value) / max;
  const path = values => values.map((value, index) => `${index ? 'L' : 'M'}${px(x(index))} ${px(y(value))}`).join('');

  let content = gridMarkup(ticks, { left, right: left + plot, y, format });
  content += pickLabels(
    marks,
    marks.map((_, index) => x(index)),
    { left, right: left + plot, narrow },
  )
    .map(item => text({ x: item.x, y: H - 8 }, item.content))
    .join('');
  if (before && before.length > 1) content += element('path', { class: 'k-ch-line k-ch-s0', d: path(before) });
  for (const item of list) {
    if (item.values.length > 1) content += element('path', { class: `k-ch-line ${item.key}`, d: path(item.values) });
    const last = item.values.length - 1;
    if (last >= 0)
      content += element('circle', { class: `k-ch-dot ${item.key}`, cx: x(last), cy: y(item.values[last]), r: 4 });
  }

  if (tipped) {
    const tips = list
      .filter(item => item.values.length)
      .map(item => ({ item, y: y(item.values[item.values.length - 1]) + 4 }));
    if (spread(tips, 13, y0 + 4, y1 + 4)) {
      content += tips
        .map(tip =>
          text({ class: 'k-ch-soft', x: left + plot + 10, y: tip.y }, fitText(tip.item.name || 'Valor', tipWidth)),
        )
        .join('');
    }
  }

  // Una franja por punto: con ella aparecen los puntos de todas las series y el globo de datos.
  const band = count === 1 ? plot : plot / (count - 1);
  for (let index = 0; index < count; index++) {
    const from = clamp(x(index) - band / 2, left, left + plot);
    const to = clamp(x(index) + band / 2, left, left + plot);
    const values = list
      .filter(item => index < item.values.length)
      .map(item => `${item.name ? `${item.name}: ` : ''}${format(item.values[index])}`);
    if (before && index < before.length) values.push(`Periodo anterior: ${format(before[index])}`);
    const tip = `${marks[index]} · ${values.join(' · ')}`;
    content += element(
      'g',
      { class: 'k-ch-pt', 'data-tip': tip },
      title(tip) +
        element('rect', { class: 'k-ch-hit', x: from, y: y0, width: Math.max(to - from, 1), height: y1 - y0 }) +
        element('line', { class: 'k-ch-guide', x1: x(index), x2: x(index), y1: y0, y2: y1 }) +
        list
          .filter(item => index < item.values.length)
          .map(item =>
            element('circle', { class: `k-ch-dot ${item.key}`, cx: x(index), cy: y(item.values[index]), r: 4 }),
          )
          .join(''),
    );
  }

  const spoken =
    summary ??
    `${label}. De ${marks[0]} a ${marks[count - 1]}. ${list
      .map((item, index) => {
        const peak = Math.max(...item.values, 0);
        return `${names[index]}: ${format(sum(item.values))} en total, máximo ${format(peak)} en ${marks[Math.max(0, item.values.indexOf(peak))]}`;
      })
      .join('. ')}.`;
  const svg = svgRoot({ kind: 'line', width: W, height: H, label: spoken, focusable: true }, content);
  const legend =
    list.length > 1 || before
      ? legendMarkup([
          ...list.map((item, index) => ({ key: item.key, text: names[index] })),
          ...(before ? [{ key: 'k-ch-s0', text: 'Periodo anterior' }] : []),
        ])
      : '';
  const rows = marks.map((mark, index) => [
    mark,
    ...list.map(item => (index < item.values.length ? item.values[index] : '')),
    ...(before ? [index < before.length ? before[index] : ''] : []),
  ]);
  return result({
    svg,
    markup: `<div class="k-chart">${svg}${legend}</div>`,
    twin: tableMarkup({ caption: label, head, rows }, format),
    label: spoken,
  });
}

/**
 * Chispa: la forma de una serie en miniatura, sin ejes, para acompañar a una cifra.
 * @param {{values: number[], label?: string, color?: number, width?: number, height?: number, format?: (value: number) => string}} data
 */
export function sparkline({
  values = [],
  label = 'Evolución',
  color,
  width = 96,
  height = 28,
  format = formatNumber,
} = {}) {
  const points = Array.from(values, toNumber);
  const W = clamp(toNumber(width) || 96, 24, 1000);
  const H = clamp(toNumber(height) || 28, 12, 400);
  const key = `k-ch-s${clamp(Math.trunc(toNumber(color)) || 7, 1, 7)}`;
  const head = ['Punto', 'Valor'];
  if (!points.length) return nothing({ kind: 'sparkline', width: W, height: H, label, head });

  const max = Math.max(...points) || 1;
  const pad = 5;
  const x = index => (points.length === 1 ? W / 2 : pad + ((W - pad * 2) * index) / (points.length - 1));
  const y = value => H - pad - ((H - pad * 2) * value) / max;
  const last = points.length - 1;
  const content =
    (points.length > 1
      ? element('path', {
          class: `k-ch-line ${key}`,
          d: points.map((value, index) => `${index ? 'L' : 'M'}${px(x(index))} ${px(y(value))}`).join(''),
        })
      : '') + element('circle', { class: `k-ch-dot ${key}`, cx: x(last), cy: y(points[last]), r: 3 });
  const spoken = `${label}: empieza en ${format(points[0])} y termina en ${format(points[last])}; máximo ${format(Math.max(...points))}.`;
  const svg = svgRoot({ kind: 'sparkline', width: W, height: H, label: spoken }, content);
  return result({
    svg,
    twin: tableMarkup({ caption: label, head, rows: points.map((value, index) => [String(index + 1), value]) }, format),
    label: spoken,
  });
}

// ---------------------------------------------------------------------------------------------------
// Columnas y barras
// ---------------------------------------------------------------------------------------------------

/**
 * Conteos por periodo en columnas, una serie o varias (lado a lado, o apiladas con `stacked`).
 * Columnas de 24 px como mucho, extremo redondeado y 2 px entre segmentos apilados.
 *
 * @param {object} data
 * @param {string[]} data.labels
 * @param {number[] | Array<{name: string, values: number[], color?: number}>} data.series
 * @param {boolean} [data.stacked]
 * @param {string} [data.label]
 * @param {string} [data.summary]
 * @param {string} [data.axis]
 * @param {(value: number) => string} [data.format]
 * @param {number} [data.width]
 * @param {number} [data.height]
 */
export function columns({
  labels = [],
  series,
  stacked = false,
  label = 'Conteos',
  summary,
  axis = 'Periodo',
  format = formatNumber,
  width = 640,
  height = 220,
} = {}) {
  const list = seriesOf(series);
  const count = Math.max(labels.length, ...list.map(item => item.values.length), 0);
  const W = clamp(toNumber(width) || 640, 160, 4000);
  const H = clamp(toNumber(height) || 220, 120, 2000);
  const names = list.map(item => item.name || 'Valor');
  const totalled = stacked && list.length > 1;
  const head = [axis, ...names, ...(totalled ? ['Total'] : [])];
  if (!count || !list.length) return nothing({ kind: 'columns', width: W, height: H, label, head });

  const marks = labelsFor(labels, count);
  const at = (item, index) => (index < item.values.length ? item.values[index] : 0);
  const totals = marks.map((_, index) => sum(list.map(item => at(item, index))));
  const top = stacked ? Math.max(...totals, 0) : Math.max(...list.flatMap(item => item.values), 0);
  const ticks = niceTicks(top, { count: H < 180 ? 3 : 4, integer: allIntegers(list.map(item => item.values)) });
  const max = ticks[ticks.length - 1];
  const left = Math.max(...ticks.map(tick => textWidth(format(tick)))) + 10;
  const [y0, y1] = [18, H - 26];
  const plot = Math.max(W - 12 - left, 10);
  const band = plot / count;
  const perBand = stacked ? 1 : list.length;
  const barWidth = clamp((band * 0.72) / perBand, Math.min(1, band), 24);
  const gap = perBand > 1 && barWidth > 3 ? 1 : 0;
  const groupWidth = barWidth * perBand + gap * (perBand - 1);
  const y = value => y1 - ((y1 - y0) * value) / max;
  const center = index => left + band * index + band / 2;

  let content = gridMarkup(ticks, { left, right: left + plot, y, format });
  content += pickLabels(
    marks,
    marks.map((_, index) => center(index)),
    { left, right: left + plot, narrow: W < 420 },
  )
    .map(item => text({ x: item.x, y: H - 8 }, item.content))
    .join('');

  // Con pocas columnas, la cifra va encima de cada una si cabe en su hueco.
  const direct =
    count <= 16 && (stacked || list.length === 1) && totals.every(total => textWidth(format(total)) <= band - 2);

  for (let index = 0; index < count; index++) {
    const start = center(index) - groupWidth / 2;
    let marksOfBand = '';
    if (stacked) {
      let base = y1;
      const present = list.filter(item => at(item, index) > 0);
      present.forEach((item, position) => {
        const full = y1 - y(at(item, index));
        const isTop = position === present.length - 1;
        const tall = Math.max(full - (isTop || full <= 4 ? 0 : 2), 1);
        const yTop = base - full + (full - tall);
        marksOfBand += isTop
          ? bar(start, yTop, barWidth, tall, 'top', { class: `k-ch-fill ${item.key}` })
          : element('rect', { class: `k-ch-fill ${item.key}`, x: start, y: yTop, width: barWidth, height: tall });
        base -= full;
      });
    } else {
      list.forEach((item, position) => {
        const value = at(item, index);
        if (value <= 0) return;
        const tall = Math.max(y1 - y(value), 1);
        marksOfBand += bar(start + position * (barWidth + gap), y1 - tall, barWidth, tall, 'top', {
          class: `k-ch-fill ${item.key}`,
        });
      });
    }
    const values = list.map(
      (item, position) => `${list.length > 1 ? `${names[position]}: ` : ''}${format(at(item, index))}`,
    );
    if (totalled) values.push(`Total: ${format(totals[index])}`);
    const tip = `${marks[index]} · ${values.join(' · ')}`;
    const shown = stacked ? totals[index] : at(list[0], index);
    content += element(
      'g',
      { class: 'k-ch-pt', 'data-tip': tip },
      title(tip) +
        element('rect', { class: 'k-ch-hit', x: left + band * index, y: y0, width: band, height: y1 - y0 }) +
        marksOfBand +
        (direct && shown > 0
          ? text({ class: 'k-ch-soft', x: center(index), y: y(shown) - 5, 'text-anchor': 'middle' }, format(shown))
          : ''),
    );
  }

  const peak = Math.max(...totals, 0);
  const spoken =
    summary ??
    `${label}. De ${marks[0]} a ${marks[count - 1]}: ${format(sum(totals))} en total, máximo ${format(peak)} en ${marks[Math.max(0, totals.indexOf(peak))]}.`;
  const svg = svgRoot({ kind: 'columns', width: W, height: H, label: spoken, focusable: true }, content);
  const legend =
    list.length > 1 ? legendMarkup(list.map((item, index) => ({ key: item.key, text: names[index] }))) : '';
  const rows = marks.map((mark, index) => [
    mark,
    ...list.map(item => at(item, index)),
    ...(totalled ? [totals[index]] : []),
  ]);
  return result({
    svg,
    markup: `<div class="k-chart">${svg}${legend}</div>`,
    twin: tableMarkup({ caption: label, head, rows }, format),
    label: spoken,
  });
}

/**
 * Comparación entre categorías: barras horizontales de mayor a menor, un solo color y la cifra en la
 * punta. El nombre va a la izquierda y se recorta si no cabe (completo, en la tabla y al pasar el cursor).
 *
 * @param {object} data
 * @param {Array<{label: string, value: number}>} data.rows
 * @param {string} [data.label]
 * @param {string} [data.summary]
 * @param {[string, string]} [data.head] Cabeceras de la tabla.
 * @param {boolean} [data.sorted] false conserva el orden recibido.
 * @param {number} [data.color] 1 a 6; por omisión, el acento.
 * @param {(value: number) => string} [data.format]
 * @param {number} [data.width]
 */
export function bars({
  rows = [],
  label = 'Comparación',
  summary,
  head = ['Concepto', 'Valor'],
  sorted = true,
  color,
  format = formatNumber,
  width = 640,
} = {}) {
  const list = Array.from(rows, row => ({ label: String(row?.label ?? ''), value: toNumber(row?.value) }));
  if (sorted) list.sort((a, b) => b.value - a.value);
  const W = clamp(toNumber(width) || 640, 160, 4000);
  const rowHeight = 28;
  const H = Math.max(list.length, 1) * rowHeight + 8;
  if (!list.length) return nothing({ kind: 'bars', width: W, height: 64, label, head });

  const key = `k-ch-s${clamp(Math.trunc(toNumber(color)) || 7, 1, 7)}`;
  const max = Math.max(...list.map(row => row.value)) || 1;
  // La cifra va fuera de la barra, así que se le reserva su hueco: nunca se sale por la derecha.
  const valueRoom = Math.max(...list.map(row => textWidth(format(row.value)))) + 10;
  const gutter = clamp(
    Math.max(...list.map(row => textWidth(row.label))) + 10,
    0,
    Math.max(0, Math.min(W * 0.42, W - valueRoom - 24)),
  );
  const plot = Math.max(W - gutter - valueRoom, 8);
  let content = '';
  list.forEach((row, index) => {
    const yTop = 4 + index * rowHeight;
    const long = row.value > 0 ? Math.max((plot * row.value) / max, 2) : 0;
    const tip = `${row.label}: ${format(row.value)}`;
    content += element(
      'g',
      { class: 'k-ch-pt', 'data-tip': tip },
      title(tip) +
        element('rect', { class: 'k-ch-hit', x: 0, y: yTop, width: W, height: rowHeight }) +
        text({ class: 'k-ch-soft', x: 1, y: yTop + 18 }, fitText(row.label, gutter - 8)) +
        element('rect', { class: 'k-ch-track', x: gutter, y: yTop + 8, width: plot, height: 12, rx: 3 }) +
        (long ? bar(gutter, yTop + 8, long, 12, 'right', { class: `k-ch-fill ${key}` }) : '') +
        text({ class: 'k-ch-strong', x: gutter + long + 6, y: yTop + 18 }, format(row.value)),
    );
  });
  const spoken =
    summary ??
    `${label}. ${list.length} ${list.length === 1 ? 'elemento' : 'elementos'}; el mayor, ${list[0].label} con ${format(list[0].value)}.`;
  const svg = svgRoot({ kind: 'bars', width: W, height: H, label: spoken, focusable: true }, content);
  return result({
    svg,
    markup: `<div class="k-chart">${svg}</div>`,
    twin: tableMarkup({ caption: label, head, rows: list.map(row => [row.label, row.value]) }, format),
    label: spoken,
  });
}

/**
 * Un todo repartido en partes (hasta seis): una barra segmentada y, debajo, cada parte con su cifra y
 * su porcentaje. Delgada junto a una cifra; alta (`tall`) cuando es la gráfica principal.
 *
 * @param {object} data
 * @param {Array<{label: string, value: number, color?: number}>} data.parts
 * @param {boolean} [data.tall]
 * @param {string} [data.label]
 * @param {string} [data.summary]
 * @param {(value: number) => string} [data.format]
 * @param {number} [data.width]
 */
export function segments({
  parts = [],
  tall = false,
  label = 'Reparto',
  summary,
  format = formatNumber,
  width = 640,
} = {}) {
  const list = Array.from(parts)
    .slice(0, 6)
    .map((part, index) => ({
      label: String(part?.label ?? ''),
      value: toNumber(part?.value),
      key: `k-ch-s${clamp(Math.trunc(toNumber(part?.color)) || index + 1, 1, 7)}`,
    }));
  const W = clamp(toNumber(width) || 640, 80, 4000);
  const H = tall ? 28 : 12;
  const head = ['Parte', 'Valor', 'Porcentaje'];
  if (!list.length) return nothing({ kind: 'segments', width: W, height: Math.max(H, 28), label, head });

  const total = sum(list.map(part => part.value));
  const share = part => (total > 0 ? part.value / total : 0);
  const visible = list.filter(part => part.value > 0);
  const gaps = Math.max(visible.length - 1, 0) * 2;
  let content = element('rect', { class: 'k-ch-track', x: 0, y: 0, width: W, height: H, rx: 4 });
  let cursor = 0;
  visible.forEach(part => {
    const wide = Math.max((W - gaps) * share(part), 2);
    const tip = `${part.label}: ${format(part.value)} (${formatPercent(share(part))})`;
    content += element(
      'g',
      { class: 'k-ch-pt', 'data-tip': tip },
      title(tip) +
        element('rect', {
          class: `k-ch-fill ${part.key}`,
          x: Math.min(cursor, W - 2),
          y: 0,
          width: Math.min(wide, Math.max(W - cursor, 2)),
          height: H,
          rx: 3,
        }),
    );
    cursor += wide + 2;
  });
  const spoken =
    summary ??
    `${label}. ${format(total)} en total: ${list.map(part => `${part.label} ${format(part.value)} (${formatPercent(share(part))})`).join(', ')}.`;
  const svg = svgRoot({ kind: 'segments', width: W, height: H, label: spoken, focusable: true }, content);
  const legend = legendMarkup(
    list.map(part => ({
      key: part.key,
      text: `${part.label} · ${format(part.value)} · ${formatPercent(share(part))}`,
    })),
  );
  const rows = list.map(part => [part.label, part.value, formatPercent(share(part))]);
  return result({
    svg,
    markup: `<div class="k-chart">${svg}${legend}</div>`,
    twin: tableMarkup({ caption: label, head, rows }, format),
    label: spoken,
  });
}

/**
 * Avance contra un tope (mensajes gratis del mes, tope de la IA).
 * @param {{value: number, limit: number, label?: string, format?: (value: number) => string, width?: number}} data
 */
export function meter({ value, limit, label = 'Avance', format = formatNumber, width = 240 } = {}) {
  const [used, cap] = [toNumber(value), toNumber(limit)];
  const W = clamp(toNumber(width) || 240, 60, 4000);
  const ratio = cap > 0 ? Math.min(used / cap, 1) : 0;
  const spoken = `${label}: ${format(used)} de ${format(cap)} (${formatPercent(cap > 0 ? used / cap : 0)}).`;
  const content =
    element('rect', { class: 'k-ch-track', x: 0, y: 0, width: W, height: 8, rx: 4 }) +
    (ratio > 0
      ? element('rect', { class: 'k-ch-fill k-ch-s7', x: 0, y: 0, width: Math.max(W * ratio, 2), height: 8, rx: 4 })
      : '');
  const svg = svgRoot({ kind: 'meter', width: W, height: 8, label: spoken }, content);
  const markup = `<div class="k-meter"><p class="k-meter__text"><span>${esc(label)}</span><span class="k-num">${esc(format(used))} de ${esc(format(cap))}</span></p>${svg}</div>`;
  const twin = tableMarkup(
    {
      caption: label,
      head: ['Dato', 'Valor'],
      rows: [
        ['Usado', used],
        ['Tope', cap],
        ['Porcentaje', formatPercent(cap > 0 ? used / cap : 0)],
      ],
    },
    format,
  );
  return result({ svg, markup, twin, label: spoken });
}

// ---------------------------------------------------------------------------------------------------
// Embudo y mapa de calor
// ---------------------------------------------------------------------------------------------------

/**
 * Embudo: una barra por etapa, de un mismo tono cada vez más oscuro, con su cifra en la punta y, bajo el
 * nombre, qué porcentaje de la etapa anterior llegó a ésta.
 *
 * @param {object} data
 * @param {Array<{label: string, value: number}>} data.steps En orden.
 * @param {string} [data.label]
 * @param {string} [data.summary]
 * @param {(value: number) => string} [data.format]
 * @param {number} [data.width]
 */
export function funnel({ steps = [], label = 'Embudo', summary, format = formatNumber, width = 640 } = {}) {
  const list = Array.from(steps, step => ({ label: String(step?.label ?? ''), value: toNumber(step?.value) }));
  const W = clamp(toNumber(width) || 640, 160, 4000);
  const rowHeight = 44;
  const head = ['Etapa', 'Valor', 'Del paso anterior'];
  if (!list.length) return nothing({ kind: 'funnel', width: W, height: 64, label, head });

  const max = Math.max(...list.map(step => step.value)) || 1;
  // Sin etapa anterior, o con la anterior en cero, no hay porcentaje que dar: se dice con una raya.
  const passes = list.map((step, index) =>
    index === 0
      ? ''
      : list[index - 1].value > 0
        ? `${formatPercent(step.value / list[index - 1].value)} del paso anterior`
        : '—',
  );
  const valueRoom = Math.max(...list.map(step => textWidth(format(step.value)))) + 10;
  const gutter = clamp(
    Math.max(...list.map(step => textWidth(step.label)), ...passes.map(textWidth)) + 12,
    0,
    Math.max(0, Math.min(W * 0.46, W - valueRoom - 24)),
  );
  const plot = Math.max(W - gutter - valueRoom, 8);
  let content = '';
  list.forEach((step, index) => {
    const yTop = index * rowHeight;
    const long = step.value > 0 ? Math.max((plot * step.value) / max, 2) : 0;
    const tip = `${step.label}: ${format(step.value)}${passes[index] && passes[index] !== '—' ? ` (${passes[index]})` : ''}`;
    content += element(
      'g',
      { class: 'k-ch-pt', 'data-tip': tip },
      title(tip) +
        element('rect', { class: 'k-ch-hit', x: 0, y: yTop, width: W, height: rowHeight }) +
        text({ class: 'k-ch-strong', x: 1, y: yTop + 18 }, fitText(step.label, gutter - 8)) +
        (passes[index] ? text({ x: 1, y: yTop + 33 }, fitText(passes[index], gutter - 8)) : '') +
        element('rect', { class: 'k-ch-track', x: gutter, y: yTop + 8, width: plot, height: 24, rx: 4 }) +
        (long ? bar(gutter, yTop + 8, long, 24, 'right', { class: `k-ch-q${Math.min(2 + index, 5)}` }) : '') +
        text({ class: 'k-ch-strong', x: gutter + long + 6, y: yTop + 24 }, format(step.value)),
    );
  });
  const first = list[0];
  const last = list[list.length - 1];
  const spoken =
    summary ??
    `${label}. ${list.length} ${list.length === 1 ? 'etapa' : 'etapas'}: de ${format(first.value)} en ${first.label} a ${format(last.value)} en ${last.label}${first.value > 0 ? ` (${formatPercent(last.value / first.value)} del inicio)` : ''}.`;
  const svg = svgRoot(
    { kind: 'funnel', width: W, height: list.length * rowHeight, label: spoken, focusable: true },
    content,
  );
  const rows = list.map((step, index) => [
    step.label,
    step.value,
    index === 0 ? '—' : passes[index].replace(' del paso anterior', ''),
  ]);
  return result({
    svg,
    markup: `<div class="k-chart">${svg}</div>`,
    twin: tableMarkup({ caption: label, head, rows }, format),
    label: spoken,
  });
}

/**
 * Mapa de calor (día × hora): cinco tonos por cuantiles sobre las celdas con actividad, con su leyenda de
 * rangos. `group` junta columnas (en celular, las 24 horas en ocho bloques de tres).
 *
 * @param {object} data
 * @param {string[]} data.rows Rótulos de las filas (días).
 * @param {string[]} data.cols Rótulos de las columnas (horas).
 * @param {number[][]} data.values Una lista por fila.
 * @param {number} [data.group] Cuántas columnas seguidas se suman en una.
 * @param {string} [data.label]
 * @param {string} [data.summary]
 * @param {(value: number) => string} [data.format]
 * @param {number} [data.width]
 */
export function heat({
  rows = [],
  cols = [],
  values = [],
  group = 1,
  label = 'Actividad',
  summary,
  format = formatNumber,
  width = 640,
} = {}) {
  const size = Math.max(1, Math.trunc(toNumber(group)) || 1);
  const rowNames = Array.from(rows, String);
  const sourceCols = Array.from(cols, String);
  const colNames = [];
  for (let start = 0; start < sourceCols.length; start += size) {
    const end = Math.min(start + size, sourceCols.length) - 1;
    colNames.push(end > start ? `${sourceCols[start]}–${sourceCols[end]}` : sourceCols[start]);
  }
  const grid = rowNames.map((_, r) =>
    colNames.map((_, c) => sum(Array.from({ length: size }, (_, k) => toNumber(values?.[r]?.[c * size + k])))),
  );
  const W = clamp(toNumber(width) || 640, 160, 4000);
  const head = ['', ...colNames];
  if (!rowNames.length || !colNames.length)
    return nothing({ kind: 'heat', width: W, height: 80, label, head: head.length > 1 ? head : ['Fila', 'Valor'] });

  const gutter = Math.min(Math.max(...rowNames.map(textWidth)) + 10, W * 0.3);
  const cellWidth = clamp((W - gutter) / colNames.length, 4, 44);
  const cellHeight = clamp(cellWidth, 16, 28);
  const top = 20;
  const H = top + rowNames.length * cellHeight + 2;

  // Cinco clases por cuantiles sobre las celdas con valor; el cero tiene su propio tono.
  const positive = grid
    .flat()
    .filter(value => value > 0)
    .sort((a, b) => a - b);
  const classOf = value =>
    value > 0 ? clamp(Math.ceil((5 * positive.filter(other => other <= value).length) / positive.length), 1, 5) : 0;

  let content = pickLabels(
    colNames,
    colNames.map((_, c) => gutter + cellWidth * c + cellWidth / 2),
    { left: gutter, right: gutter + cellWidth * colNames.length, narrow: false },
  )
    .map(item => text({ x: item.x, y: 13 }, item.content))
    .join('');
  rowNames.forEach((name, r) => {
    content += text(
      { class: 'k-ch-soft', x: 1, y: top + r * cellHeight + cellHeight / 2 + 4 },
      fitText(name, gutter - 7),
    );
    colNames.forEach((column, c) => {
      const value = grid[r][c];
      const tip = `${name}, ${column}: ${format(value)}`;
      const inset = cellWidth > 6 ? 1 : 0;
      content += element(
        'g',
        { class: 'k-ch-pt', 'data-tip': tip },
        title(tip) +
          element('rect', {
            class: `k-ch-fill k-ch-q${classOf(value)}`,
            x: gutter + cellWidth * c + inset,
            y: top + r * cellHeight + inset,
            width: cellWidth - inset * 2,
            height: cellHeight - inset * 2,
            rx: inset ? 3 : 0,
          }),
      );
    });
  });

  const ranges = [1, 2, 3, 4, 5]
    .map(level => ({ level, members: positive.filter(value => classOf(value) === level) }))
    .filter(item => item.members.length)
    .map(item => {
      const [low, high] = [item.members[0], item.members[item.members.length - 1]];
      return { key: `k-ch-q${item.level}`, text: low === high ? format(low) : `${format(low)} a ${format(high)}` };
    });
  const legend = legendMarkup([{ key: 'k-ch-q0', text: 'Sin actividad' }, ...ranges]);
  const peak = positive.length ? positive[positive.length - 1] : 0;
  const peakRow = grid.findIndex(cells => cells.includes(peak));
  const where = peak > 0 ? `${rowNames[peakRow]}, ${colNames[grid[peakRow].indexOf(peak)]}` : '';
  const spoken =
    summary ??
    (peak > 0
      ? `${label}. ${format(sum(positive))} en total; el máximo, ${format(peak)} en ${where}.`
      : `${label}: sin actividad.`);
  const svg = svgRoot(
    { kind: 'heat', width: gutter + cellWidth * colNames.length, height: H, label: spoken, focusable: true },
    content,
  );
  const twinRows = rowNames.map((name, r) => [name, ...grid[r]]);
  return result({
    svg,
    markup: `<div class="k-chart">${svg}${legend}</div>`,
    twin: tableMarkup({ caption: label, head, rows: twinRows }, format),
    label: spoken,
  });
}

// ---------------------------------------------------------------------------------------------------
// Tarjeta de cifra y envoltura
// ---------------------------------------------------------------------------------------------------

/**
 * Tarjeta de cifra: el dato, cuánto cambió frente al periodo anterior y, si se quiere, su chispa.
 * La diferencia nunca se dice sólo con color: lleva flecha y frase («12 % más que los 7 días anteriores»);
 * el color indica si es bueno o malo según `goodWhenUp`.
 *
 * @param {object} data
 * @param {string} data.label
 * @param {number | string} data.value Un número se formatea; un texto se pinta tal cual («2 h 15 min»).
 * @param {number | null} [data.delta] Cambio como fracción: 0.12 es un 12 % más. null: sin comparación.
 * @param {boolean} [data.goodWhenUp] false cuando subir es malo (perdidas, fallidos).
 * @param {string} [data.period] Con qué se compara: «los 7 días anteriores».
 * @param {string} [data.hint] Una línea de contexto.
 * @param {number[]} [data.spark] Serie para la chispa.
 * @param {(value: number) => string} [data.format]
 */
export function tile({
  label: given,
  value,
  delta = null,
  goodWhenUp = true,
  period = 'el periodo anterior',
  hint = '',
  spark,
  format = formatNumber,
} = {}) {
  // Sin nombre no hay nada que leer en voz alta ni que titular en la tabla.
  const label = String(given ?? '') || 'Dato';
  // Un número que no lo es (una división entre cero aguas arriba) se muestra como «sin dato», no como NaN.
  const shown = typeof value === 'number' ? (Number.isFinite(value) ? format(value) : '—') : String(value ?? '—');
  let change = '';
  let changeMarkup = '';
  if (typeof delta === 'number' && Number.isFinite(delta)) {
    const flat = Math.abs(delta) < 0.0005;
    change = flat
      ? `Igual que ${period}`
      : `${formatPercent(Math.abs(delta))} ${delta > 0 ? 'más' : 'menos'} que ${period}`;
    const tone = flat ? '' : delta > 0 === goodWhenUp ? ' k-tile__delta--good' : ' k-tile__delta--bad';
    changeMarkup = `<p class="k-tile__delta${tone}">${glyphMarkup(flat ? 'flat' : delta > 0 ? 'up' : 'down')}<span>${esc(change)}</span></p>`;
  }
  const mini =
    Array.isArray(spark) && spark.length ? sparkline({ values: spark, label: `Evolución de ${label}`, format }) : null;
  const spoken = `${label}: ${shown}${change ? `. ${change}` : ''}.`;
  const markup = `<div class="k-tile"><p class="k-tile__label">${esc(label)}</p><p class="k-tile__value">${esc(shown)}</p>${changeMarkup}${hint ? `<p class="k-tile__hint">${esc(hint)}</p>` : ''}${mini ? mini.svg : ''}</div>`;
  const rows = [
    ['Valor', shown],
    ...(change ? [['Cambio', change]] : []),
    ...(mini ? Array.from(spark, (point, index) => [`Punto ${index + 1}`, toNumber(point)]) : []),
  ];
  return result({
    svg: mini ? mini.svg : '',
    markup,
    twin: tableMarkup({ caption: label, head: ['Dato', 'Valor'], rows }, format),
    label: spoken,
  });
}

const HEADINGS = new Set([2, 3, 4, 5, 6]);

/**
 * Envoltura de una gráfica: título, la gráfica, «Ver tabla» con su gemela, «Descargar CSV» y «¿Cómo se
 * calcula?». Las gráficas van siempre dentro de un panel blanco (.k-card): la paleta está validada ahí.
 *
 * @param {object} data
 * @param {string} data.title
 * @param {{html: unknown, table: unknown}} data.chart Lo que devuelve line(), columns(), bars()…
 * @param {string} [data.subtitle]
 * @param {unknown} [data.table] Otra tabla en lugar de la gemela de la gráfica (hecha con table()).
 * @param {string} [data.exportHref] Dirección del CSV (del mismo origen).
 * @param {string} [data.definition] Cómo se calcula el dato, en español llano.
 * @param {number} [data.level] Nivel del título (2 a 6; por omisión 3).
 */
export function figure({
  title: heading,
  subtitle = '',
  chart,
  table: twin,
  exportHref = '',
  definition = '',
  level = 3,
}) {
  const h = HEADINGS.has(level) ? level : 3;
  // Sólo entra marcado hecho por el kit: cualquier otra cosa (un texto, un objeto de la API) se descarta.
  const safe = value => (isSafe(value) ? String(value) : '');
  const data = safe(twin ?? chart?.table);
  const href = url(exportHref);
  return raw(
    `<figure class="k-fig">` +
      `<figcaption class="k-fig__head"><h${h} class="k-fig__title">${esc(heading)}</h${h}>${subtitle ? `<p class="k-fig__sub">${esc(subtitle)}</p>` : ''}</figcaption>` +
      `<div class="k-fig__plot">${safe(chart?.html)}</div>` +
      `<div class="k-fig__more">` +
      (data ? `<details><summary>Ver tabla</summary><div class="k-data__wrap">${data}</div></details>` : '') +
      (definition
        ? `<details><summary>¿Cómo se calcula?</summary><p class="k-fig__def">${esc(definition)}</p></details>`
        : '') +
      (href && href !== '#' ? `<a class="k-link" href="${esc(href)}" download>Descargar CSV</a>` : '') +
      `</div></figure>`,
  );
}

// ---------------------------------------------------------------------------------------------------
// En el navegador: globo de datos, teclado y ancho disponible
// ---------------------------------------------------------------------------------------------------

/**
 * Un solo globo de datos para todas las gráficas dentro de `root`, por delegación: aparece al pasar el
 * cursor, al tocar y al recorrer la gráfica con el teclado (flechas, Inicio, Fin; Escape lo quita). El
 * valor se anuncia además en una región viva para lectores de pantalla.
 * Se llama una vez por pantalla; devuelve la función que quita los oyentes.
 */
export function bind(root) {
  const page = root.ownerDocument;
  const tip = page.createElement('div');
  tip.className = 'k-tip';
  tip.hidden = true;
  const live = page.createElement('p');
  live.className = 'k-sr';
  live.setAttribute('aria-live', 'polite');
  let active = null;

  function hide() {
    active?.classList.remove('is-on');
    active = null;
    tip.hidden = true;
  }

  function show(point, announce) {
    if (point === active) return;
    active?.classList.remove('is-on');
    active = point;
    point.classList.add('is-on');
    // Con el globo propio sobra el del navegador (<title>), que saldría duplicado.
    point.querySelector('title')?.remove();
    const box = point.closest('.k-fig__plot') ?? point.closest('.k-chart') ?? point.ownerSVGElement.parentNode;
    if (tip.parentNode !== box) box.append(tip, live);
    tip.textContent = point.getAttribute('data-tip');
    tip.hidden = false;
    if (announce) live.textContent = tip.textContent;
    // El globo va encima de la marca (el punto o la barra), sin salirse de su caja.
    const mark = point.querySelector('.k-ch-dot, .k-ch-fill') ?? point;
    const [area, spot] = [box.getBoundingClientRect(), mark.getBoundingClientRect()];
    const left = clamp(
      spot.left + spot.width / 2 - area.left - tip.offsetWidth / 2,
      0,
      Math.max(0, area.width - tip.offsetWidth),
    );
    const top = clamp(spot.top - area.top - tip.offsetHeight - 6, 0, Math.max(0, area.height - tip.offsetHeight));
    tip.style.transform = `translate(${Math.round(left + box.scrollLeft)}px, ${Math.round(top)}px)`;
  }

  const pointOf = event => event.target.closest?.('.k-ch-pt');
  const onOver = event => {
    const point = pointOf(event);
    if (point && root.contains(point)) show(point, false);
    else if (active) hide();
  };
  const onLeave = () => hide();
  const onKey = event => {
    const chart = event.target.closest?.('svg.k-ch');
    if (!chart || event.target !== chart) return;
    const points = Array.from(chart.querySelectorAll('.k-ch-pt'));
    if (!points.length) return;
    const at = points.indexOf(active);
    let next = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = Math.min(at + 1, points.length - 1);
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = at <= 0 ? 0 : at - 1;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = points.length - 1;
    else if (event.key === 'Escape') hide();
    if (next < 0) return;
    event.preventDefault();
    show(points[next], true);
  };
  const onBlur = event => {
    if (event.target.closest?.('svg.k-ch')) hide();
  };

  root.addEventListener('pointerover', onOver);
  root.addEventListener('pointerleave', onLeave);
  root.addEventListener('keydown', onKey);
  root.addEventListener('focusout', onBlur);
  return () => {
    root.removeEventListener('pointerover', onOver);
    root.removeEventListener('pointerleave', onLeave);
    root.removeEventListener('keydown', onKey);
    root.removeEventListener('focusout', onBlur);
    tip.remove();
    live.remove();
  };
}

/**
 * Llama a `draw(ancho)` con el ancho disponible de `element` ahora y cada vez que cambie, para volver a
 * pintar la gráfica a su medida (un SVG del kit no se escala). Devuelve la función que deja de observar.
 *
 *   const off = responsive(caja, ancho => render(caja, html`${figure({ title, chart: line({ …, width: ancho }) })}`));
 */
export function responsive(element, draw) {
  let last = -1;
  const measure = () => {
    const width = Math.floor(element.clientWidth);
    if (width > 0 && width !== last) {
      last = width;
      draw(width);
    }
  };
  const observer = new ResizeObserver(measure);
  observer.observe(element);
  measure();
  return () => observer.disconnect();
}
