import test from 'node:test';
import assert from 'node:assert/strict';
import { attrs, each, esc, html, icon, isSafe, join, morph, raw, render, url, when } from '../public/kit/html.js';
import { children, h, text } from './kit-dom.mjs';

// El kit de las pantallas nuevas pinta con html`…`, que escapa todo lo que se interpola. Estas pruebas
// son la red de seguridad de esa promesa: si alguna falla, una pantalla puede estar inyectando HTML.

const HOSTIL = `<img src=x onerror="alert('1')">&`;
const lanza = (fn, patron) => assert.throws(fn, error => error instanceof TypeError && patron.test(error.message));

test('html escapa lo interpolado en texto', () => {
  assert.equal(String(html`<p>${HOSTIL}</p>`), '<p>&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;</p>');
  assert.equal(esc(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
  assert.equal(
    String(html`<textarea>${'</textarea><script>x</script>'}</textarea>`),
    '<textarea>&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;</textarea>',
  );
});

test('html escapa lo interpolado en un atributo, con comillas dobles o simples', () => {
  const fuga = '" onmouseover="alert(1)';
  assert.equal(String(html`<p title="${fuga}">x</p>`), '<p title="&quot; onmouseover=&quot;alert(1)">x</p>');
  assert.equal(String(html`<p title='${"' onfocus='alert(1)"}'>x</p>`), "<p title='&#39; onfocus=&#39;alert(1)'>x</p>");
  // Un fragmento dentro de un atributo no es marcado: se escapa como cualquier texto.
  assert.equal(String(html`<p title="${html`<b>"x"</b>`}">y</p>`), '<p title="&lt;b&gt;&quot;x&quot;&lt;/b&gt;">y</p>');
});

test('los fragmentos anidados pasan tal cual y las listas se unen', () => {
  const fila = nombre => html`<li>${nombre}</li>`;
  assert.equal(String(html`<ul>${['a<', 'b'].map(fila)}</ul>`), '<ul><li>a&lt;</li><li>b</li></ul>');
  assert.equal(String(html`<div>${html`<p>${html`<b>${'<'}</b>`}</p>`}</div>`), '<div><p><b>&lt;</b></p></div>');
  // Cualquier iterable, no sólo listas; y las listas dentro de listas.
  assert.equal(String(html`${new Set(['<', '>'])}|${[[1, [2]], 3]}`), '&lt;&gt;|123');
});

test('null, undefined y los booleanos no pintan nada; el cero sí', () => {
  const [activa, apagada] = [true, false];
  assert.equal(String(html`[${null}${undefined}${false}${true}${0}${''}]`), '[0]');
  assert.equal(String(html`<p>${apagada && html`<b>no</b>`}${activa && html`<b>sí</b>`}</p>`), '<p><b>sí</b></p>');
});

test('en un atributo los booleanos sólo se escriben donde el atributo los espera', () => {
  const [activa, apagada] = [true, false];
  assert.equal(String(html`<a class="${apagada && 'x'}" title="${activa}">x</a>`), '<a class="" title="">x</a>');
  assert.equal(
    String(html`<a aria-expanded="${apagada}" aria-selected="${activa}" data-on="${apagada}">x</a>`),
    '<a aria-expanded="false" aria-selected="true" data-on="false">x</a>',
  );
  assert.equal(
    String(html`<a class="${['k-btn', apagada && 'no', null, activa && 'k-btn--primary', '']}">x</a>`),
    '<a class="k-btn k-btn--primary">x</a>',
  );
});

test('raw marca marcado de confianza; nada más se hace pasar por seguro', () => {
  assert.equal(String(html`<div>${raw('<b>ok</b>')}</div>`), '<div><b>ok</b></div>');
  assert.equal(isSafe(html`x`), true);
  assert.equal(isSafe(raw('x')), true);
  for (const impostor of [
    '<b>',
    { text: '<b>' },
    { toString: () => '<b>' },
    attrs({ title: 'x' }),
    JSON.parse(JSON.stringify(html`<b>x</b>`)),
  ]) {
    assert.equal(isSafe(impostor), false);
  }
  // Un objeto que se parece a un fragmento (por ejemplo, llegado por JSON) se escapa como texto.
  assert.equal(String(html`<p>${{ toString: () => '<b>hola</b>' }}</p>`), '<p>&lt;b&gt;hola&lt;/b&gt;</p>');
  assert.equal(String(html`<p>${JSON.parse(JSON.stringify(html`<b>x</b>`))}</p>`), '<p>[object Object]</p>');
  // El texto de un fragmento vuelve a escaparse si se interpola como cadena: no es una puerta trasera.
  assert.equal(String(html`<p>${String(html`<b>x</b>`)}</p>`), '<p>&lt;b&gt;x&lt;/b&gt;</p>');
});

test('html se niega a pintar donde el escape no protege', () => {
  lanza(() => html`<a title=${'x y'}>x</a>`, /entre comillas/);
  lanza(() => html`<a ${'onclick=alert(1)'}>x</a>`, /attrs/);
  lanza(() => html`<a data-${'x'}="1">x</a>`, /no se interpolan/);
  lanza(() => html`<${'img src=x onerror=alert(1)'}>`, /no se interpolan/);
  lanza(() => html`<div>x</${'div'}>`, /no se interpolan/);
  lanza(() => html`<script>${'alert(1)'}</script>`, /<script>/);
  lanza(() => html`<style>${'x{}'}</style>`, /<style>/);
  lanza(() => html`<p style="color:${'red'}">x</p>`, /style/);
  lanza(() => html`<p onclick="${'x'}">x</p>`, /manejadores en línea/);
  lanza(() => html`<iframe srcdoc="${'x'}"></iframe>`, /srcdoc/);
  lanza(() => html`<!-- ${'x'} --><p>y</p>`, /comentario/);
  lanza(() => html`<p class="x`, /a medias/);
  lanza(() => html('<b>hola</b>'), /plantilla etiquetada/);
  lanza(() => html(['<b>', '</b>'], 'x'), /plantilla etiquetada/);
});

test('una dirección interpolada sólo pasa si es del mismo origen o https', () => {
  const enlace = destino => String(html`<a href="${destino}">x</a>`);
  assert.equal(enlace('/crm/c/1?a=1&b=2'), '<a href="/crm/c/1?a=1&amp;b=2">x</a>');
  assert.equal(enlace('https://example.com/a'), '<a href="https://example.com/a">x</a>');
  for (const malo of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,x',
    '//otro.sitio/x',
    '/\\otro.sitio',
    'http://sin-cifrar.test',
    'vbscript:x',
  ]) {
    assert.equal(enlace(malo), '<a href="#">x</a>', malo);
  }
  assert.deepEqual(['pagina.html', '?q=1', '#a', '/a b', '', null].map(url), [
    'pagina.html',
    '?q=1',
    '#a',
    '/a b',
    '',
    '',
  ]);
  assert.equal(String(html`<img src="${'javascript:x'}" alt="">`), '<img src="#" alt="">');
  // Una dirección armada a trozos no se puede comprobar entera: hay que pasarla completa.
  lanza(() => html`<a href="/crm/${'x'}">x</a>`, /dirección completa/);
  lanza(() => html`<a href="${'/a'}${'b'}">x</a>`, /dirección completa/);
});

test('attrs escribe atributos opcionales y booleanos, sólo dentro de una etiqueta', () => {
  assert.equal(
    String(
      html`<input ${attrs({ checked: true, disabled: false, hidden: null, 'aria-label': 'a"b', maxlength: 80, class: ['a', false, 'b'] })}>`,
    ),
    '<input checked aria-label="a&quot;b" maxlength="80" class="a b">',
  );
  assert.equal(String(html`<a ${attrs({ href: 'javascript:alert(1)' })}>x</a>`), '<a href="#">x</a>');
  assert.equal(String(html`<a ${null}${false}${attrs({})}>x</a>`), '<a >x</a>');
  // Pegado a unas comillas o a otro hueco, el espacio que separa los atributos lo pone la plantilla.
  assert.equal(
    String(html`<input class="k-input"${attrs({ required: true })}${attrs({ disabled: true })}${attrs({})}>`),
    '<input class="k-input" required disabled>',
  );
  lanza(() => attrs({ onclick: 'x' }), /manejadores en línea/);
  lanza(() => attrs({ style: 'color:red' }), /style/);
  lanza(() => attrs({ 'x y': '1' }), /no válido/);
  lanza(() => attrs({ 'x"onload="1': '1' }), /no válido/);
  lanza(() => html`<p>${attrs({ title: 'x' })}</p>`, /dentro de una etiqueta/);
  lanza(() => html`<p ${html`<b>x</b>`}>y</p>`, /attrs/);
});

test('when, each y join arman partes condicionales y listas', () => {
  assert.equal(
    String(
      html`${when(
        0,
        () => 'sí',
        () => html`<i>no</i>`,
      )}|${when(1, 'a <')}|${when(false, 'x')}|`,
    ),
    '<i>no</i>|a &lt;||',
  );
  let evaluada = false;
  when(false, () => (evaluada = true));
  assert.equal(evaluada, false, 'la rama que no toca no se evalúa');
  assert.equal(
    String(html`<ul>${each([], x => x, html`<li>vacío</li>`)}${each(['a<'], (x, i) => html`<li>${i}:${x}</li>`)}</ul>`),
    '<ul><li>vacío</li><li>0:a&lt;</li></ul>',
  );
  assert.equal(String(join(['a<', html`<b>b</b>`, null, '', 'c'], ' · ')), 'a&lt; · <b>b</b> · c');
  assert.equal(String(icon('chevron-right')), '<i data-lucide="chevron-right" aria-hidden="true"></i>');
  lanza(() => icon('x" onload="1'), /no válido/);
});

test('la misma plantilla se puede evaluar muchas veces con valores distintos', () => {
  const fila = (clase, valor) => html`<td class="${clase}">${valor}</td>`;
  assert.equal(String(fila('a', 1)), '<td class="a">1</td>');
  assert.equal(String(fila('<', '>')), '<td class="&lt;">&gt;</td>');
});

test('render sólo acepta fragmentos y pinta en un destino vacío', () => {
  const destino = { firstChild: null, innerHTML: '', querySelectorAll: () => [], querySelector: () => null };
  render(destino, html`<p>${'<'}</p>`);
  assert.equal(destino.innerHTML, '<p>&lt;</p>');
  for (const malo of ['<p>x</p>', null, { text: '<p>' }, attrs({ a: 1 })]) {
    assert.throws(() => render(destino, malo), TypeError);
  }
  assert.equal(destino.innerHTML, '<p>&lt;</p>', 'un render rechazado no toca el destino');
});

// morph() es lo que hace que un repintado no destruya lo que hay: conserva los nodos (y con ellos el foco,
// el cursor y el desplazamiento). Se prueba con un árbol de mentira.

test('morph reutiliza los nodos y sólo cambia lo que cambió', () => {
  const lista = h('ul', {}, h('li', { class: 'a' }, 'uno'), h('li', {}, 'dos'));
  const [primero, segundo] = lista.childNodes;
  morph(lista, h('ul', {}, h('li', { class: 'b', title: 't' }, 'UNO'), h('li', {}, 'dos'), h('li', {}, 'tres')));
  assert.equal(children(lista), '<li class="b" title="t">UNO</li><li>dos</li><li>tres</li>');
  assert.equal(lista.childNodes[0], primero, 'el primer <li> es el mismo nodo');
  assert.equal(lista.childNodes[1], segundo);
  morph(lista, h('ul', {}, h('li', {}, 'UNO')));
  assert.equal(children(lista), '<li>UNO</li>');
  assert.equal(lista.childNodes[0], primero);
  // Otra etiqueta en el mismo sitio no se reutiliza.
  morph(lista, h('ul', {}, h('p', {}, 'x')));
  assert.equal(children(lista), '<p>x</p>');
  assert.notEqual(lista.childNodes[0], primero);
});

test('morph reconoce los nodos con data-key o id aunque cambien de sitio', () => {
  const lista = h(
    'ul',
    {},
    h('li', { 'data-key': 'a' }, 'A'),
    h('li', { 'data-key': 'b' }, 'B'),
    h('li', { id: 'c' }, 'C'),
  );
  const [a, b, c] = lista.childNodes;
  morph(
    lista,
    h('ul', {}, h('li', { id: 'c' }, 'C2'), h('li', { 'data-key': 'nuevo' }, 'N'), h('li', { 'data-key': 'a' }, 'A2')),
  );
  assert.equal(children(lista), '<li id="c">C2</li><li data-key="nuevo">N</li><li data-key="a">A2</li>');
  assert.equal(lista.childNodes[0], c);
  assert.equal(lista.childNodes[2], a);
  assert.equal(b.parentNode, null, 'el que ya no está se quita');
  // Una clave repetida en el marcado nuevo no reutiliza dos veces el mismo nodo.
  morph(lista, h('ul', {}, h('li', { 'data-key': 'a' }, '1'), h('li', { 'data-key': 'a' }, '2')));
  assert.equal(children(lista), '<li data-key="a">1</li><li data-key="a">2</li>');
  assert.equal(lista.childNodes[0], a);
  assert.notEqual(lista.childNodes[1], a);
});

test('morph no toca una ranura: ni su contenido ni sus atributos', () => {
  const pagina = h(
    'section',
    {},
    h('h1', {}, 'Antes'),
    h('div', { 'data-slot': 'tabla', hidden: true }, h('table', {}, 'filas')),
  );
  const ranura = pagina.childNodes[1];
  morph(pagina, h('section', {}, h('h1', {}, 'Después'), h('p', {}, 'nuevo'), h('div', { 'data-slot': 'tabla' })));
  assert.equal(
    children(pagina),
    '<h1>Después</h1><p>nuevo</p><div data-slot="tabla" hidden=""><table>filas</table></div>',
  );
  assert.equal(pagina.childNodes[2], ranura);
  // Una ranura con otro nombre es otra ranura.
  morph(pagina, h('section', {}, h('div', { 'data-slot': 'otra' })));
  assert.equal(children(pagina), '<div data-slot="otra"></div>');
});

test('morph respeta lo que la persona teclea y pinta lo marcado desde el estado', () => {
  const formulario = h(
    'form',
    {},
    h('input', { type: 'text', name: 'q', value: 'ho' }),
    h('input', { type: 'checkbox', name: 'ok' }),
    h('details', { open: true }, h('summary', {}, 's')),
  );
  const [campo, casilla, detalles] = formulario.childNodes;
  campo.value = 'hola'; // la persona siguió escribiendo
  casilla.checked = true; // y marcó la casilla
  // El marcado no cambió: lo tecleado se queda; la casilla vuelve a lo que dice el estado.
  morph(
    formulario,
    h(
      'form',
      {},
      h('input', { type: 'text', name: 'q', value: 'ho' }),
      h('input', { type: 'checkbox', name: 'ok' }),
      h('details', {}, h('summary', {}, 's')),
    ),
  );
  assert.equal(campo.value, 'hola');
  assert.equal(casilla.checked, false);
  assert.equal(detalles.hasAttribute('open'), true, 'un <details> abierto no se pliega al repintar');
  // El estado cambia el valor (por ejemplo, vacía el campo tras enviar): entonces sí se escribe.
  morph(
    formulario,
    h(
      'form',
      {},
      h('input', { type: 'text', name: 'q', value: '' }),
      h('input', { type: 'checkbox', name: 'ok', checked: true }),
      h('details', {}, h('summary', {}, 's')),
    ),
  );
  assert.equal(campo.value, '');
  assert.equal(casilla.checked, true);
  assert.equal(formulario.childNodes[0], campo, 'el campo es el mismo nodo: no pierde el foco');
  // Un <input> de otro tipo no es el mismo campo.
  morph(formulario, h('form', {}, h('input', { type: 'email', name: 'q', value: '' })));
  assert.notEqual(formulario.childNodes[0], campo);
});

test('morph pone al día las opciones de un <select> y el texto de un <textarea>', () => {
  const lista = h('select', {}, h('option', { value: 'a', selected: true }, 'A'), h('option', { value: 'b' }, 'B'));
  morph(lista, h('select', {}, h('option', { value: 'a' }, 'A'), h('option', { value: 'b', selected: true }, 'B')));
  assert.deepEqual(
    lista.childNodes.map(option => option.selected),
    [false, true],
  );

  const caja = h('div', {}, h('textarea', { name: 'n' }, 'antes'));
  const area = caja.childNodes[0];
  area.value = 'antes y algo más';
  morph(caja, h('div', {}, h('textarea', { name: 'n' }, 'antes')));
  assert.equal(area.value, 'antes y algo más', 'sin cambio en el marcado no se pisa lo escrito');
  morph(caja, h('div', {}, h('textarea', { name: 'n' }, 'después')));
  assert.equal(area.value, 'después');
});

test('morph deja en paz los iconos que la aplicación ya convirtió en SVG', () => {
  const boton = h('button', {}, h('svg', { 'data-lucide': 'plus', class: 'lucide' }, h('path', {})), text(' Nuevo'));
  const icono = boton.childNodes[0];
  morph(boton, h('button', {}, h('i', { 'data-lucide': 'plus', 'aria-hidden': 'true' }), text(' Nueva')));
  assert.equal(boton.childNodes[0], icono);
  assert.equal(children(boton), '<svg data-lucide="plus" class="lucide"><path></path></svg> Nueva');
  // Otro icono sí se sustituye.
  morph(boton, h('button', {}, h('i', { 'data-lucide': 'x' }), text(' Nueva')));
  assert.equal(children(boton), '<i data-lucide="x"></i> Nueva');
});
