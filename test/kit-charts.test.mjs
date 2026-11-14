import test from 'node:test';
import assert from 'node:assert/strict';
import { html, isSafe } from '../public/kit/html.js';
import {
  bars,
  columns,
  figure,
  fitText,
  formatPercent,
  funnel,
  heat,
  line,
  meter,
  niceTicks,
  segments,
  sparkline,
  table,
  textWidth,
  tile,
} from '../public/kit/charts.js';

// Las gráficas del kit son funciones puras que devuelven texto: se pueden probar aquí sin navegador.
// Lo que se vigila es lo que más se rompe en una gráfica hecha a mano: datos vacíos o de un solo punto
// que acaban en NaN, rótulos largos que se salen, texto sin escapar y gráficas sin su tabla.

const HOSTIL = `<script>alert("x")</script> & 'comillas' ${'muy largo '.repeat(20)}`;
const ANCHOS = [160, 343, 640, 1200];

/** XML bien formado: etiquetas cerradas y bien anidadas, atributos entre comillas y texto escapado. */
function bienFormado(marcado, nombre) {
  const pila = [];
  const pieza = /<\/([a-zA-Z][\w:-]*)>|<([a-zA-Z][\w:-]*)((?:\s+[\w:-]+(?:="[^"<]*")?)*)\s*(\/?)>|([^<]+)/y;
  let en = 0;
  while (en < marcado.length) {
    pieza.lastIndex = en;
    const m = pieza.exec(marcado);
    assert.ok(m, `${nombre}: marcado mal formado cerca de «${marcado.slice(en, en + 80)}»`);
    en = pieza.lastIndex;
    if (m[1]) assert.equal(pila.pop(), m[1], `${nombre}: se cierra </${m[1]}> fuera de sitio`);
    else if (m[2]) {
      assert.ok(!/&(?!(?:amp|lt|gt|quot|#39);)/.test(m[3]), `${nombre}: atributo sin escapar en <${m[2]}>`);
      if (!m[4]) pila.push(m[2]);
    } else assert.ok(!/&(?!(?:amp|lt|gt|quot|#39);)/.test(m[5]), `${nombre}: texto sin escapar «${m[5].slice(0, 40)}»`);
  }
  assert.deepEqual(pila, [], `${nombre}: quedaron etiquetas sin cerrar`);
}

const sinEscapar = textoEscapado =>
  textoEscapado
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&');

/**
 * Lo que toda gráfica debe cumplir, sea cual sea el dato. La tarjeta de cifra (`tarjeta`) no es un SVG:
 * su SVG, si lo hay, es la chispa que lleva dentro, con su propio resumen.
 */
function revisar(grafica, nombre, { tarjeta = false } = {}) {
  assert.equal(typeof grafica.svg, 'string', `${nombre}: svg es texto`);
  assert.ok(isSafe(grafica.html), `${nombre}: html es un fragmento`);
  assert.ok(isSafe(grafica.table), `${nombre}: la tabla es un fragmento`);
  assert.ok(grafica.label && typeof grafica.label === 'string', `${nombre}: tiene resumen leído`);
  const marcado = `${grafica.svg}\n${grafica.html}\n${grafica.table}`;
  assert.ok(
    !/NaN|Infinity|undefined|\bnull\b/.test(`${marcado}\n${grafica.label}`),
    `${nombre}: aparece NaN, Infinity, undefined o null`,
  );
  // El resumen es texto llano (se escapa al escribirlo en el aria-label); el marcado nunca lleva el dato crudo.
  assert.ok(!/<script|onerror=|javascript:/i.test(marcado), `${nombre}: hay marcado sin escapar`);
  // Ni colores ni estilos escritos en el marcado: todo sale de las clases k-ch-… y de tokens.css.
  assert.ok(
    !/#[0-9a-f]{3,8}\b|rgb\(|hsl\(|style=|font-size=|fill="|stroke="/i.test(`${grafica.svg}${grafica.html}`),
    `${nombre}: color o estilo escrito a mano`,
  );

  // La tabla gemela: con título y cabeceras con alcance.
  const tabla = String(grafica.table);
  bienFormado(tabla, `${nombre} (tabla)`);
  assert.match(
    tabla,
    /^<table class="k-data"><caption>[^<]+<\/caption><thead><tr>(<th scope="col"[^>]*>[^<]*<\/th>)+<\/tr><\/thead><tbody>/,
    `${nombre}: tabla sin título o sin cabeceras`,
  );
  assert.match(tabla, /<tbody>(<tr>.+<\/tr>)+<\/tbody><\/table>$/s, `${nombre}: tabla sin filas`);
  bienFormado(String(grafica.html), `${nombre} (html)`);

  if (tarjeta && !grafica.svg) return;
  const svg = grafica.svg;
  bienFormado(svg, nombre);
  const raiz = svg.match(
    /^<svg class="k-ch" xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="([\d.]+)" height="([\d.]+)" viewBox="0 0 ([\d.]+) ([\d.]+)" role="img" aria-label="([^"]+)"/,
  );
  assert.ok(raiz, `${nombre}: el <svg> no tiene tamaño, role="img" y aria-label`);
  const [ancho, alto] = [Number(raiz[1]), Number(raiz[2])];
  assert.ok(
    ancho > 0 && alto > 0 && ancho === Number(raiz[3]) && alto === Number(raiz[4]),
    `${nombre}: el SVG no mide lo que dice su viewBox (se escalaría)`,
  );
  if (!tarjeta) assert.equal(sinEscapar(raiz[5]), grafica.label, `${nombre}: el aria-label es el resumen`);
  assert.ok(svg.endsWith('</svg>'), `${nombre}: el SVG termina en </svg>`);

  // Toda coordenada es un número finito y no negativo.
  for (const [, atributo, valor] of svg.matchAll(/\s(x|y|x1|x2|y1|y2|cx|cy|r|rx|width|height)="([^"]*)"/g)) {
    assert.ok(Number.isFinite(Number(valor)) && Number(valor) >= 0, `${nombre}: ${atributo}="${valor}"`);
  }
  for (const [, trazo] of svg.matchAll(/\sd="([^"]*)"/g))
    assert.match(trazo, /^[MLHVQZ\d .-]+$/, `${nombre}: trazo no válido`);

  // Ningún rótulo se sale del lienzo (con el mismo cálculo de ancho, por exceso, que usa la gráfica).
  for (const [, atributos, contenido] of svg.matchAll(/<text([^>]*)>([^<]*)<\/text>/g)) {
    const x = Number(atributos.match(/\sx="([^"]*)"/)[1]);
    const y = Number(atributos.match(/\sy="([^"]*)"/)[1]);
    const ancla = atributos.match(/text-anchor="(\w+)"/)?.[1] ?? 'start';
    const largo = textWidth(sinEscapar(contenido));
    const desde = ancla === 'end' ? x - largo : ancla === 'middle' ? x - largo / 2 : x;
    assert.ok(
      desde >= -0.5 && desde + largo <= ancho + 0.5,
      `${nombre}: el rótulo «${contenido}» se sale (${desde.toFixed(1)} a ${(desde + largo).toFixed(1)} de ${ancho})`,
    );
    assert.ok(y >= 8 && y <= alto + 0.5, `${nombre}: el rótulo «${contenido}» se sale en vertical (y=${y} de ${alto})`);
  }
}

const dias = n => Array.from({ length: n }, (_, i) => `Día ${i + 1}`);
const serie = (n, f = i => (i * 37) % 101) => Array.from({ length: n }, (_, i) => f(i));

/** Cada forma con sus casos difíciles: {nombre: fabrica(ancho)}. */
const CASOS = {
  line: {
    vacia: width => line({ labels: [], series: [], width }),
    'sin series': width => line({ labels: dias(3), width }),
    ceros: width => line({ labels: dias(7), series: serie(7, () => 0), width }),
    'un punto': width => line({ labels: ['Hoy'], series: [5], width }),
    'un punto en cero': width => line({ labels: ['Hoy'], series: [0], previous: [0], width }),
    '366 puntos': width =>
      line({ label: 'Un año', labels: dias(366), series: serie(366), previous: serie(366, i => i % 50), width }),
    'cuatro series': width =>
      line({
        labels: dias(12),
        series: ['A', 'B', 'C', 'D'].map((name, k) => ({
          name: `${name} con un nombre largo`,
          values: serie(12, () => 10 + k),
          color: k + 1,
        })),
        width,
      }),
    'rótulos largos': width =>
      line({
        label: HOSTIL,
        labels: [HOSTIL, HOSTIL, HOSTIL],
        series: [
          { name: HOSTIL, values: [1, 2, 3] },
          { name: HOSTIL, values: [3, 2, 1] },
        ],
        width,
      }),
    'valores raros': width => line({ labels: dias(5), series: [NaN, -4, Infinity, '7', null], width }),
    'cifras enormes': width => line({ labels: dias(4), series: [1e12, 3e12, 2e12, 9e12], width }),
    'series desiguales': width =>
      line({
        labels: dias(6),
        series: [
          { name: 'Corta', values: [1, 2] },
          { name: 'Larga', values: serie(6) },
        ],
        width,
      }),
  },
  columns: {
    vacia: width => columns({ labels: [], series: [], width }),
    ceros: width => columns({ labels: dias(7), series: serie(7, () => 0), width }),
    'un punto': width => columns({ labels: ['Hoy'], series: [5], width }),
    '366 puntos': width => columns({ labels: dias(366), series: serie(366), width }),
    apiladas: width =>
      columns({
        labels: dias(14),
        stacked: true,
        series: [
          { name: 'Servicio', values: serie(14) },
          { name: 'Marketing', values: serie(14, i => i % 7), color: 2 },
        ],
        width,
      }),
    'apiladas en cero': width =>
      columns({
        labels: dias(3),
        stacked: true,
        series: [
          { name: 'A', values: [0, 0, 0] },
          { name: 'B', values: [0, 0, 0] },
        ],
        width,
      }),
    'lado a lado': width =>
      columns({
        labels: dias(5),
        series: [
          { name: 'A', values: serie(5) },
          { name: 'B', values: serie(5, i => i) },
        ],
        width,
      }),
    'rótulos largos': width =>
      columns({ label: HOSTIL, labels: [HOSTIL, HOSTIL], series: [{ name: HOSTIL, values: [1, 2] }], width }),
    'valores raros': width => columns({ labels: dias(4), series: [NaN, -4, Infinity, 'x'], width }),
    'cifras enormes': width => columns({ labels: dias(3), series: [1e12, 3e12, 2e12], width }),
  },
  bars: {
    vacia: width => bars({ rows: [], width }),
    ceros: width =>
      bars({
        rows: [
          { label: 'A', value: 0 },
          { label: 'B', value: 0 },
        ],
        width,
      }),
    'una fila': width => bars({ rows: [{ label: 'Única', value: 3 }], width }),
    '366 filas': width => bars({ rows: serie(366).map((value, i) => ({ label: `Motivo ${i}`, value })), width }),
    'rótulos largos': width =>
      bars({
        label: HOSTIL,
        rows: [
          { label: HOSTIL, value: 12 },
          { label: HOSTIL, value: 1234567.89 },
        ],
        width,
      }),
    'valores raros': width => bars({ rows: [{ label: 'A', value: NaN }, { label: 'B', value: -1 }, {}, null], width }),
  },
  segments: {
    vacia: width => segments({ parts: [], width }),
    ceros: width =>
      segments({
        parts: [
          { label: 'A', value: 0 },
          { label: 'B', value: 0 },
        ],
        width,
      }),
    'una parte': width => segments({ parts: [{ label: 'Todo', value: 9 }], tall: true, width }),
    '366 partes': width => segments({ parts: serie(366).map((value, i) => ({ label: `P${i}`, value })), width }),
    'parte diminuta': width =>
      segments({
        parts: [
          { label: 'Casi todo', value: 1e9 },
          { label: 'Casi nada', value: 1 },
          { label: 'Nada', value: 0 },
        ],
        width,
      }),
    'rótulos largos': width =>
      segments({
        label: HOSTIL,
        parts: [
          { label: HOSTIL, value: 1 },
          { label: HOSTIL, value: 2 },
        ],
        width,
      }),
  },
  funnel: {
    vacio: width => funnel({ steps: [], width }),
    ceros: width =>
      funnel({
        steps: [
          { label: 'A', value: 0 },
          { label: 'B', value: 0 },
        ],
        width,
      }),
    'una etapa': width => funnel({ steps: [{ label: 'Sola', value: 7 }], width }),
    '366 etapas': width => funnel({ steps: serie(366).map((value, i) => ({ label: `Etapa ${i}`, value })), width }),
    'crece tras un cero': width =>
      funnel({
        steps: [
          { label: 'A', value: 10 },
          { label: 'B', value: 0 },
          { label: 'C', value: 5 },
        ],
        width,
      }),
    'rótulos largos': width =>
      funnel({
        label: HOSTIL,
        steps: [
          { label: HOSTIL, value: 100 },
          { label: HOSTIL, value: 40 },
        ],
        width,
      }),
  },
  heat: {
    vacio: width => heat({ rows: [], cols: [], values: [], width }),
    'sin columnas': width => heat({ rows: ['Lun'], cols: [], values: [[]], width }),
    ceros: width =>
      heat({
        rows: ['Lun', 'Mar'],
        cols: ['0', '1', '2'],
        values: [
          [0, 0, 0],
          [0, 0, 0],
        ],
        width,
      }),
    'una celda': width => heat({ rows: ['Lun'], cols: ['9 h'], values: [[4]], width }),
    'una semana por horas': width =>
      heat({
        rows: ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'],
        cols: serie(24, i => `${i} h`),
        values: serie(7, d => serie(24, hh => (d * hh) % 9)),
        width,
      }),
    agrupado: width =>
      heat({
        rows: ['Lun', 'Mar'],
        cols: serie(24, i => `${i} h`),
        values: [serie(24), serie(24, () => 1)],
        group: 3,
        width,
      }),
    '366 columnas': width =>
      heat({ rows: ['A', 'B'], cols: dias(366), values: [serie(366), serie(366, i => i % 3)], width }),
    'rótulos largos': width =>
      heat({
        label: HOSTIL,
        rows: [HOSTIL, HOSTIL],
        cols: [HOSTIL, HOSTIL],
        values: [
          [1, 2],
          [3, 4],
        ],
        width,
      }),
    'valores raros': width => heat({ rows: ['A'], cols: ['1', '2', '3'], values: [[NaN, -2, 'x']], width }),
    'faltan filas': width => heat({ rows: ['A', 'B', 'C'], cols: ['1', '2'], values: [[1]], width }),
  },
  sparkline: {
    vacia: () => sparkline({ values: [] }),
    ceros: () => sparkline({ values: [0, 0, 0] }),
    'un punto': () => sparkline({ values: [3] }),
    '366 puntos': () => sparkline({ values: serie(366), width: 120 }),
    'rótulo largo': () => sparkline({ values: [1, 2], label: HOSTIL }),
    'valores raros': () => sparkline({ values: [NaN, -1, Infinity] }),
  },
  meter: {
    'sin tope': width => meter({ value: 5, limit: 0, width }),
    ceros: width => meter({ value: 0, limit: 0, width }),
    'pasado del tope': width => meter({ value: 1500, limit: 1000, width }),
    'rótulo largo': width => meter({ value: 1, limit: 2, label: HOSTIL, width }),
    'valores raros': width => meter({ value: NaN, limit: undefined, width }),
  },
};

for (const [forma, casos] of Object.entries(CASOS)) {
  test(`${forma}: se pinta con cualquier dato, a cualquier ancho, y trae su tabla`, () => {
    for (const [caso, fabrica] of Object.entries(casos)) {
      for (const ancho of ANCHOS) revisar(fabrica(ancho), `${forma} · ${caso} · ${ancho}px`);
    }
  });
}

test('tile: la cifra, su cambio con flecha y frase, y su chispa', () => {
  const casos = {
    completa: tile({
      label: 'Cerradas',
      value: 241,
      delta: 0.124,
      period: 'los 7 días anteriores',
      spark: [3, 5, 4, 8],
      hint: 'Hoy',
    }),
    'sin cambio': tile({ label: 'Enviados', value: 10, delta: 0 }),
    'baja y es malo': tile({ label: 'Cerradas', value: 5, delta: -0.5 }),
    'sube y es malo': tile({ label: 'Perdidas', value: 9, delta: 0.2, goodWhenUp: false }),
    'sin comparación': tile({ label: 'Primera respuesta', value: '4 min' }),
    'valor que no es número': tile({ label: 'Tasa', value: NaN, delta: NaN, spark: [] }),
    'chispa de 366': tile({ label: 'Año', value: 1e9, spark: serie(366) }),
    'rótulo largo': tile({ label: HOSTIL, value: HOSTIL, hint: HOSTIL, period: HOSTIL, delta: 1 }),
    vacia: tile(),
  };
  for (const [caso, tarjeta] of Object.entries(casos)) revisar(tarjeta, `tile · ${caso}`, { tarjeta: true });
  assert.match(String(casos.completa.html), /12\.4 % más que los 7 días anteriores/);
  assert.match(String(casos.completa.html), /k-tile__delta--good/);
  assert.match(String(casos['baja y es malo'].html), /k-tile__delta--bad[^>]*>.*50 % menos que el periodo anterior/s);
  assert.match(String(casos['sube y es malo'].html), /k-tile__delta--bad/);
  assert.match(String(casos['sin cambio'].html), /Igual que el periodo anterior/);
  assert.ok(!String(casos['sin comparación'].html).includes('k-tile__delta'));
  assert.match(casos['valor que no es número'].label, /Tasa: —/);
  assert.ok(casos.completa.svg.startsWith('<svg'), 'la chispa va dentro de la tarjeta');
});

test('el texto de los datos se escapa siempre', () => {
  const g = bars({ label: 'A & B', rows: [{ label: '<b>negrita</b>', value: 1 }] });
  assert.ok(g.svg.includes('&lt;b&gt;negrita&lt;/b&gt;'));
  assert.ok(String(g.table).includes('<th scope="row">&lt;b&gt;negrita&lt;/b&gt;</th>'));
  assert.ok(String(g.table).includes('<caption>A &amp; B</caption>'));
  const l = line({ labels: ['"a"'], series: [{ name: "O'Brien", values: [1] }] });
  assert.ok(l.svg.includes('&quot;a&quot;') && String(l.table).includes('O&#39;Brien'));
});

test('las formas dicen lo que deben', () => {
  // Barras: de mayor a menor salvo que se pida conservar el orden.
  const filas = [
    { label: 'poco', value: 1 },
    { label: 'mucho', value: 9 },
  ];
  assert.ok(String(bars({ rows: filas }).table).indexOf('mucho') < String(bars({ rows: filas }).table).indexOf('poco'));
  assert.ok(
    String(bars({ rows: filas, sorted: false }).table).indexOf('poco') <
      String(bars({ rows: filas, sorted: false }).table).indexOf('mucho'),
  );
  // Embudo: porcentaje de paso entre etapas; sin etapa anterior no hay porcentaje.
  const embudo = funnel({
    steps: [
      { label: 'Enviados', value: 200 },
      { label: 'Leídos', value: 50 },
      { label: 'Nada', value: 0 },
      { label: 'Vuelve', value: 5 },
    ],
  });
  assert.match(embudo.svg, /25 % del paso anterior/);
  assert.match(String(embudo.table), /<td>25 %<\/td>/);
  assert.match(embudo.svg, />—</, 'tras una etapa en cero no se inventa un porcentaje');
  // Línea: con varias series hay leyenda; con una sola, no.
  assert.ok(
    String(
      line({
        labels: dias(3),
        series: [
          { name: 'A', values: [1, 2, 3] },
          { name: 'B', values: [3, 2, 1] },
        ],
      }).html,
    ).includes('k-legend'),
  );
  assert.ok(!String(line({ labels: dias(3), series: [1, 2, 3] }).html).includes('k-legend'));
  // Cada punto lleva su franja con el valor, para el cursor y para el teclado.
  assert.equal(line({ labels: dias(5), series: [1, 2, 3, 4, 5] }).svg.match(/class="k-ch-pt"/g).length, 5);
  assert.match(
    line({ labels: ['Lun'], series: [{ name: 'Recibidos', values: [7] }] }).svg,
    /data-tip="Lun · Recibidos: 7"/,
  );
  // El color sigue a la entidad: la serie declara su número.
  assert.match(
    line({
      labels: dias(2),
      series: [
        { name: 'IA', values: [1, 2], color: 5 },
        { name: 'Reglas', values: [2, 1], color: 1 },
      ],
    }).svg,
    /k-ch-line k-ch-s5/,
  );
  // Apiladas: la tabla trae el total.
  assert.match(
    String(
      columns({
        labels: ['L'],
        stacked: true,
        series: [
          { name: 'A', values: [2] },
          { name: 'B', values: [3] },
        ],
      }).table,
    ),
    /<th scope="col" class="k-num">Total<\/th>.*<td class="k-num">5<\/td>/s,
  );
  // Mapa de calor: cinco tonos como mucho, el cero aparte, y la leyenda con rangos.
  const calor = heat({ rows: ['L'], cols: serie(10, i => `${i}`), values: [serie(10, i => i)] });
  assert.deepEqual([...new Set(calor.svg.match(/k-ch-q\d/g))].sort(), [
    'k-ch-q0',
    'k-ch-q1',
    'k-ch-q2',
    'k-ch-q3',
    'k-ch-q4',
    'k-ch-q5',
  ]);
  assert.match(String(calor.html), /Sin actividad/);
  // Agrupar columnas suma sus valores y une sus rótulos.
  assert.match(
    String(heat({ rows: ['L'], cols: ['0', '1', '2', '3'], values: [[1, 2, 3, 4]], group: 2 }).table),
    /<th scope="col" class="k-num">0–1<\/th><th scope="col" class="k-num">2–3<\/th>.*<td class="k-num">3<\/td><td class="k-num">7<\/td>/s,
  );
  // Segmentos: porcentajes que suman el todo.
  assert.match(
    segments({
      parts: [
        { label: 'A', value: 1 },
        { label: 'B', value: 3 },
      ],
    }).label,
    /A 1 \(25 %\), B 3 \(75 %\)/,
  );
  // Medidor: nunca pasa del 100 % de ancho, pero dice la cifra real.
  const medidor = meter({ value: 1500, limit: 1000, width: 200 });
  assert.match(medidor.svg, /class="k-ch-fill k-ch-s7" x="0" y="0" width="200"/);
  assert.match(medidor.label, /1,500 de 1,000 \(150 %\)/);
});

test('figure envuelve la gráfica con su tabla y no acepta marcado ajeno', () => {
  const grafica = line({ label: 'Mensajes', labels: dias(3), series: [1, 2, 3] });
  const figura = String(
    figure({
      title: 'Mensajes <por día>',
      subtitle: 'Últimos 3 días',
      chart: grafica,
      definition: 'Se cuenta cada mensaje una vez.',
      exportHref: '/api/x.csv',
    }),
  );
  bienFormado(figura.replace(' download>', ' download="">'), 'figure');
  assert.match(
    figura,
    /^<figure class="k-fig"><figcaption class="k-fig__head"><h3 class="k-fig__title">Mensajes &lt;por día&gt;<\/h3>/,
  );
  assert.ok(figura.includes(grafica.svg) && figura.includes(String(grafica.table)));
  assert.match(figura, /<summary>Ver tabla<\/summary>/);
  assert.match(
    figura,
    /<summary>¿Cómo se calcula\?<\/summary><p class="k-fig__def">Se cuenta cada mensaje una vez\.<\/p>/,
  );
  assert.match(figura, /<a class="k-link" href="\/api\/x\.csv" download>Descargar CSV<\/a>/);
  assert.ok(isSafe(figure({ title: 'x', chart: grafica })));
  // Se puede interpolar en una plantilla sin que se escape dos veces.
  assert.ok(String(html`<div>${figure({ title: 'x', chart: grafica })}</div>`).includes('<figure class="k-fig">'));
  // Ni un texto ni un objeto cualquiera pasan como gráfica; ni una dirección ajena como descarga.
  const falsa = String(
    figure({
      title: 'x',
      chart: { html: '<img src=x onerror=alert(1)>', table: '<b>x</b>' },
      exportHref: 'javascript:alert(1)',
    }),
  );
  assert.ok(!falsa.includes('<img') && !falsa.includes('<b>') && !falsa.includes('Descargar'));
  assert.match(String(figure({ title: 'x', chart: grafica, level: 2 })), /<h2 class="k-fig__title">/);
  assert.match(String(figure({ title: 'x', chart: grafica, level: 9 })), /<h3 class="k-fig__title">/);
  // Otra tabla en lugar de la gemela.
  const otra = table({ caption: 'Detalle', head: ['Motivo', 'Envíos'], rows: [['Uno', 1234.5]] });
  assert.match(
    String(figure({ title: 'x', chart: grafica, table: otra })),
    /<caption>Detalle<\/caption>.*<td class="k-num">1,234\.5<\/td>/s,
  );
});

test('las ayudas de escala y de texto no fallan en los bordes', () => {
  assert.deepEqual(niceTicks(0), [0, 0.25, 0.5, 0.75, 1]);
  assert.deepEqual(niceTicks(0, { integer: true }), [0, 1]);
  assert.deepEqual(niceTicks(3, { integer: true }), [0, 1, 2, 3]);
  assert.deepEqual(niceTicks(241), [0, 100, 200, 300]);
  assert.deepEqual(niceTicks(NaN), niceTicks(0));
  assert.deepEqual(niceTicks(-5), niceTicks(0));
  for (const tope of [0.0003, 0.37, 1, 7, 99, 100, 101, 12345, 1e12]) {
    const marcas = niceTicks(tope);
    assert.ok(marcas.length >= 2 && marcas.length <= 7, `marcas de ${tope}: ${marcas}`);
    assert.ok(marcas[0] === 0 && marcas[marcas.length - 1] >= tope && marcas.every(Number.isFinite));
  }
  assert.equal(fitText('corto', 500), 'corto');
  assert.ok(fitText('un texto bastante largo que no cabe', 60).endsWith('…'));
  assert.ok(textWidth(fitText('un texto bastante largo que no cabe', 60)) <= 60);
  assert.equal(fitText('abc', 2), '');
  assert.equal(formatPercent(0.124), '12.4 %');
  assert.equal(formatPercent(NaN), '0 %');
});
