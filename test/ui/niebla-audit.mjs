// Auditoría de Niebla que se ejecuta DENTRO de la página (page.evaluate): por eso es una sola función sin
// dependencias. Es la misma medición de docs/DISENO_Y_AUDITORIA.md, más las áreas táctiles y el desborde.
export function nieblaAudit() {
  const root = document.querySelector('#page') ?? document.body;
  const parse = color => {
    const match = color.match(/rgba?\(([^)]+)\)/);
    if (!match) return null;
    const parts = match[1].split(',').map(parseFloat);
    return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
  };
  const luminance = ({ r, g, b }) => {
    const channel = value => {
      value /= 255;
      return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
  };
  // Fondo efectivo: se mezclan los fondos translúcidos de los ancestros sobre blanco.
  const backgroundOf = element => {
    let current = element;
    let mixed = { r: 255, g: 255, b: 255 };
    const layers = [];
    while (current && current !== document.documentElement) {
      const color = parse(getComputedStyle(current).backgroundColor);
      if (color && color.a > 0) {
        layers.push(color);
        if (color.a >= 0.99) break;
      }
      current = current.parentElement;
    }
    for (const color of layers.reverse())
      mixed = {
        r: mixed.r * (1 - color.a) + color.r * color.a,
        g: mixed.g * (1 - color.a) + color.g * color.a,
        b: mixed.b * (1 - color.a) + color.b * color.a,
      };
    return mixed;
  };
  const ratio = (a, b) => {
    const x = luminance(a);
    const y = luminance(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  let total = 0;
  const small = [];
  const contrast = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.textContent.trim();
    if (!text) continue;
    const element = node.parentElement;
    const style = getComputedStyle(element);
    if (!element.getClientRects().length || style.visibility === 'hidden') continue;
    total++;
    const foreground = parse(style.color);
    if (!foreground) continue;
    const background = backgroundOf(element);
    const shown = {
      r: foreground.r * foreground.a + background.r * (1 - foreground.a),
      g: foreground.g * foreground.a + background.g * (1 - foreground.a),
      b: foreground.b * foreground.a + background.b * (1 - foreground.a),
    };
    const size = parseFloat(style.fontSize);
    const large = size >= 18 || (size >= 14 && Number(style.fontWeight) >= 700);
    const label = `${text.slice(0, 30)} (${size}px)`;
    if (size < 11) small.push(label);
    const value = ratio(shown, background);
    if (value < (large ? 3 : 4.5)) contrast.push(`${value.toFixed(2)} · ${label}`);
  }

  // Áreas táctiles: controles visibles y habilitados de la vista con menos de 40 px en alguna dimensión.
  const targets = [];
  for (const control of root.querySelectorAll(
    'button, a[href], select, summary, input:not([type="hidden"]), textarea, [role="button"]',
  )) {
    const box = control.getBoundingClientRect();
    const style = getComputedStyle(control);
    if (!box.width || !box.height || style.visibility === 'hidden' || control.disabled) continue;
    // Una casilla o un botón de opción cuentan por su etiqueta, que es lo que se toca.
    const touch = control.matches('input[type="checkbox"], input[type="radio"]')
      ? (control.closest('label')?.getBoundingClientRect() ?? box)
      : box;
    if (Math.min(touch.width, touch.height) < 39.5)
      targets.push(
        `${control.tagName.toLowerCase()}${control.id ? '#' + control.id : ''} «${(control.getAttribute('aria-label') || control.textContent || '').trim().slice(0, 24)}» ${Math.round(touch.width)}×${Math.round(touch.height)}`,
      );
  }

  return {
    total,
    under11px: small.length,
    smallSample: small.slice(0, 6),
    contrastFailures: contrast.length,
    contrastSample: contrast.slice(0, 6),
    smallTargets: targets.length,
    targetSample: targets.slice(0, 6),
    overflowX: Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  };
}
