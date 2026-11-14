import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Reglas de las pantallas nuevas que se pueden comprobar leyendo los archivos, sin navegador. Son las
// de docs/GUIA_PANTALLAS.md: el HTML sólo se pinta con el kit, los colores y la letra salen de
// public/tokens.css, nada escucha fuera de su raíz y dar de alta una pantalla es añadir una carpeta.

const RAIZ = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const leer = ruta => readFileSync(join(RAIZ, ruta), 'utf8');
const unix = ruta => ruta.split(sep).join('/');

function archivos(carpeta, extension) {
  const encontrados = [];
  const recorrer = ruta => {
    const completa = join(RAIZ, ruta);
    if (!existsSync(completa)) return;
    if (statSync(completa).isDirectory()) for (const nombre of readdirSync(completa)) recorrer(join(ruta, nombre));
    else if (!extension || ruta.endsWith(extension)) encontrados.push(unix(ruta));
  };
  recorrer(carpeta);
  return encontrados.sort();
}

// EXCEPCIÓN TEMPORAL: el lienzo de automatización se construyó en paralelo al kit, con sus propios ayudantes
// (dom.js) y una página de demostración. Mientras se pasa al kit, estas reglas no lo revisan. Al terminar esa
// migración esta lista debe quedar vacía; no se añade nada más aquí.
const PENDIENTE_DE_MIGRAR = ['public/screens/automatizacion/lienzo/'];
const yaMigrado = ruta => !PENDIENTE_DE_MIGRAR.some(prefijo => ruta.startsWith(prefijo));

const JS = [...archivos('public/kit', '.js'), ...archivos('public/screens', '.js')].filter(yaMigrado);
const CSS = [...archivos('public/kit', '.css'), ...archivos('public/screens', '.css')].filter(yaMigrado);
const NUEVOS = [
  ...archivos('public/kit'),
  ...archivos('public/screens'),
  'public/tokens.css',
  'docs/GUIA_PANTALLAS.md',
  ...archivos('test').filter(ruta => /\/kit-[^/]+\.mjs$/.test(ruta)),
];

const sinComentariosCss = texto => texto.replace(/\/\*[\s\S]*?\*\//g, '');
/** Código sin comentarios, para no confundir una explicación («nunca uses innerHTML») con un uso. */
const sinComentariosJs = texto => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Propiedades personalizadas declaradas en los bloques :root de una hoja. */
function variablesDeRaiz(texto) {
  const variables = new Map();
  for (const [, cuerpo] of sinComentariosCss(texto).matchAll(/:root\s*\{([^}]*)\}/g)) {
    for (const declaracion of cuerpo.split(';')) {
      const corte = declaracion.indexOf(':');
      const nombre = declaracion.slice(0, corte).trim();
      if (corte > 0 && nombre.startsWith('--')) variables.set(nombre, declaracion.slice(corte + 1).trim());
    }
  }
  return variables;
}

/** El mismo valor aunque cambien los espacios o el cero inicial (lo que hace un formateador). */
const normal = valor =>
  valor
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/(^|[^\d.])0+\./g, '$1.');

const TOKENS = variablesDeRaiz(leer('public/tokens.css'));

/** Declaraciones «propiedad: valor» de una hoja, con el archivo para los mensajes. */
function declaraciones(ruta) {
  const lista = [];
  for (const [, propiedad, valor] of sinComentariosCss(leer(ruta)).matchAll(
    /(?:^|[;{\s])(--[\w-]+|[a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/g,
  )) {
    lista.push({ propiedad, valor: valor.trim(), donde: `${ruta} → ${propiedad}: ${valor.trim()}` });
  }
  return lista;
}

test('hay archivos que revisar: el kit, la hoja de variables y la pantalla de ejemplo', () => {
  for (const ruta of [
    'public/tokens.css',
    'public/kit/kit.css',
    'public/kit/html.js',
    'public/kit/charts.js',
    'public/screens/ejemplo/index.js',
    'public/screens/ejemplo/screen.json',
  ]) {
    assert.ok(existsSync(join(RAIZ, ruta)), `falta ${ruta}`);
  }
  assert.ok(JS.length >= 15 && CSS.length >= 2);
});

test('tokens.css tiene todas las variables de hoy, con los mismos valores', () => {
  let vistas = 0;
  for (const hoja of ['public/styles.css', 'public/polish.css']) {
    for (const [nombre, valor] of variablesDeRaiz(leer(hoja))) {
      vistas++;
      assert.ok(TOKENS.has(nombre), `${nombre} (de ${hoja}) falta en public/tokens.css`);
      assert.equal(
        normal(TOKENS.get(nombre)),
        normal(valor),
        `${nombre} vale distinto en ${hoja} y en public/tokens.css`,
      );
    }
  }
  assert.ok(vistas >= 30, 'no se pudieron leer las variables de las hojas actuales');
  // La hoja de variables no decide tipografía ni fondo de la página: eso sigue en styles.css.
  assert.ok(
    !/(?:^|[;{\s])(?:font-family|color|background)\s*:/.test(
      sinComentariosCss(leer('public/tokens.css')).replace(/--[\w-]+\s*:[^;]*;/g, ''),
    ),
  );
});

test('las medidas de Niebla están en la hoja de variables', () => {
  assert.equal(TOKENS.get('--touch'), '40px', 'lo que se toca mide al menos 40 px');
  assert.equal(TOKENS.get('--font-min'), '11px', 'la letra mínima es de 11 px');
  const letras = [...TOKENS].filter(([nombre]) => nombre.startsWith('--font-'));
  assert.ok(letras.length >= 5);
  for (const [nombre, valor] of letras) {
    assert.match(valor, /^\d+px$/, `${nombre} debe ir en px`);
    assert.ok(parseInt(valor, 10) >= 11, `${nombre}: ${valor} baja de 11 px`);
  }
  for (const nombre of [
    '--ch-1',
    '--ch-2',
    '--ch-3',
    '--ch-4',
    '--ch-5',
    '--ch-6',
    '--ch-seq-0',
    '--ch-seq-5',
    '--ch-neutral',
  ]) {
    assert.ok(TOKENS.has(nombre), `falta ${nombre} en la paleta de gráficas`);
  }
});

test('las hojas nuevas no escriben colores, sombras ni tamaños de letra a mano', () => {
  const COLOR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i;
  const NOMBRADO =
    /\b(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink|brown|navy|teal|gold|beige|ivory)\b/i;
  for (const ruta of CSS) {
    const texto = sinComentariosCss(leer(ruta));
    assert.ok(!texto.includes('!important'), `${ruta}: !important no se usa`);
    assert.ok(!/@import/.test(texto), `${ruta}: sin @import (y sin tipografías de terceros)`);
    const propias = new Set(
      declaraciones(ruta)
        .filter(d => d.propiedad.startsWith('--'))
        .map(d => d.propiedad),
    );
    for (const { propiedad, valor, donde } of declaraciones(ruta)) {
      assert.ok(!COLOR.test(valor), `color escrito a mano: ${donde}`);
      if (/color|background|border|outline|fill|stroke|shadow|accent/.test(propiedad) || propiedad.startsWith('--')) {
        assert.ok(!NOMBRADO.test(valor.replace(/var\([^)]*\)/g, '')), `color con nombre: ${donde}`);
      }
      // Toda variable usada existe: en tokens.css o declarada en la misma hoja (las --k-… de las series).
      for (const [, nombre] of valor.matchAll(/var\(\s*(--[\w-]+)/g)) {
        assert.ok(TOKENS.has(nombre) || propias.has(nombre), `variable desconocida ${nombre}: ${donde}`);
      }
      if (propiedad === 'font-size')
        assert.match(valor, /^(?:var\(--font-[\w-]+\)|inherit)$/, `tamaño de letra fuera de la escala: ${donde}`);
      if (propiedad === 'font') assert.equal(valor, 'inherit', `la abreviatura font sólo hereda: ${donde}`);
      if (propiedad === 'box-shadow')
        assert.match(valor, /^(?:none|var\(--shadow-[\w-]+\))$/, `sombra fuera de la hoja de variables: ${donde}`);
    }
  }
});

test('el HTML sólo se pinta con el kit: nadie más toca innerHTML', () => {
  const PROHIBIDO = [
    [/\binnerHTML\b|\bouterHTML\b/, 'innerHTML/outerHTML'],
    [/\binsertAdjacentHTML\b/, 'insertAdjacentHTML'],
    [/\bdocument\s*\.\s*write(?:ln)?\b/, 'document.write'],
    [/\beval\s*\(|\bnew\s+Function\b/, 'eval o new Function'],
    [/\bDOMParser\b|\bcreateContextualFragment\b|\bsetHTML(?:Unsafe)?\b/, 'otra forma de analizar HTML'],
  ];
  for (const ruta of JS) {
    const codigo = sinComentariosJs(leer(ruta));
    for (const [patron, nombre] of PROHIBIDO) {
      if (ruta === 'public/kit/html.js' && nombre === 'innerHTML/outerHTML') continue;
      assert.ok(!patron.test(codigo), `${ruta} usa ${nombre}; el HTML se pinta con render(el, html\`…\`)`);
    }
  }
  // En html.js, innerHTML sólo recibe el texto de un fragmento ya comprobado: nunca una cadena armada ahí.
  const usos = sinComentariosJs(leer('public/kit/html.js')).match(/[^\n]*\binnerHTML\b[^\n]*/g) ?? [];
  assert.deepEqual(usos.map(linea => linea.trim()).sort(), [
    'if (!target.firstChild) target.innerHTML = text;',
    'next.innerHTML = text;',
  ]);
  assert.match(
    leer('public/kit/html.js'),
    /const text = Safe\.unwrap\(content, MARKUP\);\s*if \(text === null\) throw new TypeError/,
  );
});

test('las pantallas no marcan HTML como seguro por su cuenta ni escriben estilos o manejadores en línea', () => {
  for (const ruta of JS) {
    const codigo = sinComentariosJs(leer(ruta));
    if (ruta.startsWith('public/screens/')) {
      assert.ok(!/\braw\s*\(/.test(codigo), `${ruta} usa raw(); en una pantalla todo pasa por html\`…\``);
      assert.ok(
        !/from\s+['"][^'"]*\/html\.js['"]/.test(codigo) ||
          !/\bimport\s*\{[^}]*\braw\b[^}]*\}\s*from\s+['"][^'"]*\/html\.js['"]/.test(codigo),
        `${ruta} importa raw`,
      );
    }
    assert.ok(!/\sstyle\s*=\s*["'`$]/.test(codigo), `${ruta}: un atributo style en el marcado; usa una clase`);
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=\s*["'$]/i.test(codigo), `${ruta}: un manejador en línea en el marcado`);
    assert.ok(!/<script\b/i.test(codigo), `${ruta}: una etiqueta <script> en el marcado`);
    assert.ok(!/#[0-9a-f]{6}\b|\brgba?\(|\bhsla?\(/i.test(codigo), `${ruta}: un color escrito en el código`);
  }
});

test('nada nuevo escucha fuera de su raíz, crea globales ni guarda en el navegador', () => {
  // Los catorce atributos por los que public/app.js reparte los clics: una pantalla nueva no los usa.
  const HEREDADOS =
    /data-(?:action|view|mode|source|filter|conversation|new-channel|quick|chat-action|template|start-course|course-detail|edit-course|course-flyer)\b/;
  for (const ruta of JS) {
    const codigo = sinComentariosJs(leer(ruta));
    assert.ok(!HEREDADOS.test(codigo), `${ruta} usa un atributo data-… del código actual; los eventos van con data-do`);
    assert.ok(
      !/\b(?:localStorage|sessionStorage|indexedDB)\b/.test(codigo),
      `${ruta} guarda en el navegador; lo que deba sobrevivir va en ctx.keep`,
    );
    assert.ok(!/\bdocument\s*\.\s*cookie\b/.test(codigo), `${ruta} lee o escribe cookies`);
    // Un id escrito a mano podría empezar por un prefijo que reclama un módulo actual (pay-, co-, ct-…):
    // los ids salen de ctx.uid() o nextId(), que siempre empiezan por «k-».
    for (const [, fijo] of codigo.matchAll(/\sid="([^"$]+)"/g)) {
      assert.ok(fijo.startsWith('k-'), `${ruta}: id="${fijo}" escrito a mano; usa ctx.uid('…')`);
    }
    if (ruta !== 'public/kit/boot.js')
      assert.ok(
        !/\bwindow\s*\.\s*\w+\s*(?:\?\?)?=[^=]/.test(codigo),
        `${ruta} crea un global en window; sólo existe window.TC`,
      );
    if (ruta.startsWith('public/screens/')) {
      assert.ok(
        !/\b(?:document|window)\s*\.\s*addEventListener\b/.test(codigo),
        `${ruta} escucha en document o window; se escucha en la raíz con listen()`,
      );
      assert.ok(
        !/\bgetElementById\b|\bdocument\s*\.\s*querySelector/.test(codigo),
        `${ruta} busca en todo el documento; se busca dentro de su raíz`,
      );
      assert.ok(
        !/\bfetch\s*\(/.test(codigo) || ruta.endsWith('/datos.js'),
        `${ruta} llama a fetch; las peticiones van por ctx.api`,
      );
    }
  }
  assert.match(leer('public/kit/boot.js'), /window\.TC \?\?= \{\}/);
});

test('los módulos se importan con rutas relativas a archivos que existen, sin dependencias', () => {
  for (const ruta of JS) {
    const codigo = sinComentariosJs(leer(ruta));
    const especificadores = [...codigo.matchAll(/\b(?:import|export)\s+(?:[^'"`;]*?\sfrom\s+)?['"]([^'"]+)['"]/g)].map(
      m => m[1],
    );
    for (const especificador of especificadores) {
      assert.match(
        especificador,
        /^\.{1,2}\/[a-z0-9._/-]+\.js$/,
        `${ruta} importa «${especificador}»: sólo rutas relativas a un .js en minúsculas`,
      );
      assert.ok(
        existsSync(resolve(RAIZ, dirname(ruta), especificador)),
        `${ruta} importa «${especificador}», que no existe`,
      );
    }
    assert.ok(!/\brequire\s*\(/.test(codigo), `${ruta} usa require`);
  }
});

test('lo que se sirve tiene nombre en minúsculas y una extensión permitida', () => {
  for (const ruta of [...archivos('public/kit'), ...archivos('public/screens')].filter(yaMigrado)) {
    assert.match(
      relative('public', ruta).split(sep).join('/'),
      /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\.(?:js|css|json|svg|png|woff2)$/,
      `${ruta}: el servidor no lo serviría`,
    );
  }
});

test('cada pantalla trae un screen.json válido y un módulo con mount()', async () => {
  const VISTAS_ACTUALES = [
    'inbox',
    'courses',
    'activity',
    'day',
    'contacts',
    'opportunities',
    'tasks',
    'team',
    'settings',
    'operations',
    'analytics',
    'results',
    'agenda',
    'presentation',
  ];
  // Una carpeta sin screen.json todavía no es una pantalla (el servidor la ignora: server/app/screens.mjs).
  const carpetas = readdirSync(join(RAIZ, 'public/screens')).filter(
    nombre =>
      statSync(join(RAIZ, 'public/screens', nombre)).isDirectory() &&
      existsSync(join(RAIZ, 'public/screens', nombre, 'screen.json')),
  );
  assert.ok(carpetas.includes('ejemplo'));
  for (const carpeta of carpetas) {
    const base = `public/screens/${carpeta}`;
    const datos = JSON.parse(leer(`${base}/screen.json`));
    assert.equal(datos.id, carpeta, `${base}: id debe ser el nombre de la carpeta`);
    assert.match(datos.id, /^[a-z][a-z0-9-]{2,30}$/);
    assert.ok(!VISTAS_ACTUALES.includes(datos.id), `${base}: «${datos.id}» ya es una vista actual`);
    assert.ok(
      typeof datos.title === 'string' && datos.title.length > 0 && datos.title.length <= 60,
      `${base}: title es un texto de 1 a 60 caracteres`,
    );
    assert.ok(
      Array.isArray(datos.roles) &&
        datos.roles.length > 0 &&
        datos.roles.every(rol => rol === 'admin' || rol === 'agent'),
      `${base}: roles es una lista no vacía de «admin» y «agent»`,
    );
    assert.match(datos.entry, /^[a-z0-9][a-z0-9._-]*\.js$/);
    assert.ok(existsSync(join(RAIZ, base, datos.entry)), `${base}: falta ${datos.entry}`);
    for (const hoja of datos.styles ?? []) {
      assert.match(hoja, /^[a-z0-9][a-z0-9._-]*\.css$/);
      assert.ok(existsSync(join(RAIZ, base, hoja)), `${base}: falta ${hoja}`);
    }
    if (datos.nav) {
      assert.ok(typeof datos.nav.group === 'string' && datos.nav.group.length > 0);
      assert.match(datos.nav.icon, /^[a-z][a-z0-9-]*$/);
      assert.ok(datos.nav.label === undefined || (typeof datos.nav.label === 'string' && datos.nav.label.length <= 30));
      assert.equal(typeof datos.nav.order, 'number');
    }
    assert.ok(datos.visibility === undefined || datos.visibility === 'preview' || datos.visibility === 'live');
    const modulo = await import(pathToFileURL(join(RAIZ, base, datos.entry)).href);
    assert.equal(typeof modulo.default?.mount, 'function', `${base}: el módulo exporta por omisión {mount}`);
    assert.ok(modulo.default.onEvent === undefined || typeof modulo.default.onEvent === 'function');
  }
  // La de ejemplo no se publica en el menú de producción.
  assert.equal(JSON.parse(leer('public/screens/ejemplo/screen.json')).visibility, 'preview');
});

test('los archivos nuevos son UTF-8 válido, terminan en salto de línea y no llevan caracteres invisibles', () => {
  // Códigos que no se ven y rompen búsquedas y comparaciones: BOM, anchos cero, marcas de dirección,
  // espacios duros y separadores de línea. Si hacen falta, se construyen con String.fromCharCode.
  // Los finales de línea (LF) los vigila la comprobación de codificación del repositorio, no esta prueba:
  // así no falla en una copia de trabajo que Git haya convertido a CRLF.
  const INVISIBLES = new Set([
    0xfeff, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x00a0, 0x00ad, 0x2028, 0x2029, 0x202a, 0x202b, 0x202c,
    0x202d, 0x202e, 0x202f, 0x2066, 0x2067, 0x2068, 0x2069,
  ]);
  for (const ruta of NUEVOS) {
    if (!existsSync(join(RAIZ, ruta)) || /\.(?:png|woff2)$/.test(ruta)) continue;
    const bytes = readFileSync(join(RAIZ, ruta));
    const texto = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    assert.equal(bytes[bytes.length - 1], 10, `${ruta}: falta el salto de línea final`);
    let linea = 1;
    for (const caracter of texto) {
      const codigo = caracter.codePointAt(0);
      if (codigo === 10) linea++;
      else if (codigo !== 13)
        assert.ok(
          codigo >= 32 && codigo !== 127 && !INVISIBLES.has(codigo),
          `${ruta}:${linea}: carácter invisible U+${codigo.toString(16).padStart(4, '0')}`,
        );
    }
  }
});
