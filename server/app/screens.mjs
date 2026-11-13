// Registro de pantallas nuevas. Cada pantalla es una carpeta public/screens/<id>/ con su screen.json:
//
//   { "id": "difusiones", "title": "Difusiones", "visibility": "preview",
//     "nav": { "group": "Gestión", "icon": "megaphone", "label": "Difusiones", "order": 40 },
//     "roles": ["admin", "agent"], "entry": "index.js", "styles": ["screen.css"] }
//
// El servidor publica la lista en GET /screens/index.json y el navegador (public/kit/boot.js) la usa para armar el
// menú y cargar cada pantalla la primera vez que se abre. Dar de alta una pantalla no toca index.html, app.js ni
// el servidor. La lista no es un secreto: el permiso real lo impone cada API.
//
// `visibility`: "preview" (por omisión) sólo aparece con SCREENS_PREVIEW=1, que se usa al desarrollar y en las
// pruebas; "live" aparece siempre. Así una pantalla puede estar en `main` sin verse en producción hasta que se
// decide publicarla. Una carpeta sin screen.json todavía no es una pantalla y se ignora.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Vistas de la interfaz actual (public/app.js): una pantalla nueva no puede llamarse igual.
export const LEGACY_VIEWS = Object.freeze([
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
]);
const ROLES = ['admin', 'agent'];
const ID = /^[a-z][a-z0-9-]{2,30}$/;
const SCRIPT = /^[a-z0-9][a-z0-9._-]*\.js$/;
const STYLE = /^[a-z0-9][a-z0-9._-]*\.css$/;
const ICON = /^[a-z][a-z0-9-]{0,40}$/;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

// Devuelve la pantalla normalizada o lanza un error que dice qué está mal y dónde.
export function validateScreen(raw, folder, dir) {
  const where = `public/screens/${folder}/screen.json`;
  const bad = message => new Error(`${where}: ${message}`);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw bad('debe ser un objeto.');
  if (raw.id !== folder) throw bad(`«id» debe ser igual al nombre de la carpeta (${folder}).`);
  if (!ID.test(raw.id)) throw bad('«id» debe tener de 3 a 31 caracteres: minúsculas, números y guiones.');
  if (LEGACY_VIEWS.includes(raw.id)) throw bad(`«${raw.id}» ya es una vista de la interfaz actual.`);
  if (!text(raw.title, 60)) throw bad('«title» es obligatorio (hasta 60 caracteres).');
  const visibility = raw.visibility ?? 'preview';
  if (!['preview', 'live'].includes(visibility)) throw bad('«visibility» debe ser "preview" o "live".');
  if (!Array.isArray(raw.roles) || !raw.roles.length || raw.roles.some(role => !ROLES.includes(role)))
    throw bad('«roles» debe listar "admin", "agent" o ambos.');
  if (!SCRIPT.test(raw.entry ?? '')) throw bad('«entry» debe ser un archivo .js de la carpeta.');
  const styles = raw.styles ?? [];
  if (!Array.isArray(styles) || styles.some(file => !STYLE.test(file)))
    throw bad('«styles» debe ser una lista de archivos .css de la carpeta.');
  for (const file of [raw.entry, ...styles])
    if (!existsSync(join(dir, file))) throw bad(`no existe el archivo ${file}.`);
  let nav = null;
  if (raw.nav != null) {
    const { group, icon, label, order } = raw.nav;
    if (!text(group, 30)) throw bad('«nav.group» es obligatorio (el grupo del menú).');
    if (!ICON.test(icon ?? '')) throw bad('«nav.icon» debe ser el nombre de un icono.');
    if (label !== undefined && !text(label, 30)) throw bad('«nav.label» admite hasta 30 caracteres.');
    if (!Number.isFinite(order)) throw bad('«nav.order» debe ser un número.');
    nav = { group: group.trim(), icon, label: (label ?? raw.title).trim(), order };
  }
  return {
    id: raw.id,
    title: raw.title.trim(),
    visibility,
    nav,
    roles: ROLES.filter(role => raw.roles.includes(role)),
    entry: raw.entry,
    styles: [...styles],
  };
}

// Lee todas las pantallas. Con `strict` (pruebas) una pantalla mal declarada es un error; sin él (el servidor)
// se omite y se devuelve en `errors`, para que un screen.json roto no impida arrancar.
export function loadScreens({ root, preview = false, strict = false }) {
  const base = resolve(root, 'public', 'screens');
  const all = [];
  const errors = [];
  const folders = existsSync(base)
    ? readdirSync(base, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
    : [];
  for (const folder of folders) {
    const dir = join(base, folder);
    if (!existsSync(join(dir, 'screen.json'))) continue;
    try {
      let raw;
      try {
        raw = JSON.parse(readFileSync(join(dir, 'screen.json'), 'utf8'));
      } catch (error) {
        throw new Error(`public/screens/${folder}/screen.json: no es JSON válido (${error.message}).`);
      }
      all.push(validateScreen(raw, folder, dir));
    } catch (error) {
      if (strict) throw error;
      errors.push(error.message);
    }
  }
  const visible = all
    .filter(screen => preview || screen.visibility === 'live')
    .sort((a, b) => (a.nav?.order ?? Infinity) - (b.nav?.order ?? Infinity) || a.id.localeCompare(b.id));
  return { all, visible, errors, bytes: Buffer.from(JSON.stringify({ screens: visible }), 'utf8') };
}
