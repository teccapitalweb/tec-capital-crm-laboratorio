// Páginas del permiso de un asistente (docs/PLAN_MCP_OAUTH.md): entrar, «esta cuenta no puede», el permiso y los
// errores. HTML armado en el servidor con todo escapado; el único guion es /oauth/consent.js (mismo origen: la política
// de contenido no admite guiones en línea). El diseño es Tinta (tokens.css + kit.css + consent.css).
const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);

function layout(title, body, data = {}) {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` data-${k}="${esc(v)}"`)
    .join('');
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<title>${esc(title)} · CRM</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700;800&amp;display=swap">
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/kit/kit.css">
<link rel="stylesheet" href="/oauth/consent.css">
<script type="module" src="/oauth/consent.js"></script>
</head>
<body class="oa-body">
<main id="page" class="oa-page"${attrs}>
<header class="oa-brand"><span class="oa-mark" aria-hidden="true">tc</span><span>CRM · Conectar un asistente</span></header>
${body}
</main>
</body>
</html>`;
}

export function errorPage(message) {
  return layout(
    'No se pudo conectar',
    `<section class="oa-card oa-card--bad" role="alert">
  <h1>No se pudo conectar el asistente</h1>
  <p>${esc(message)}</p>
  <p class="oa-muted">Vuelve a la aplicación del asistente y empieza de nuevo. Si el problema sigue, avisa a administración.</p>
  <a class="k-btn" href="/crm">Ir al CRM</a>
</section>`,
    { state: 'error' },
  );
}

export function loginPage(client) {
  return layout(
    'Entra para continuar',
    `<section class="oa-card">
  <p class="oa-eyebrow">Paso 1 de 2</p>
  <h1>Entra al CRM para continuar</h1>
  <p><strong>${esc(client.name)}</strong> quiere conectarse al CRM. Primero entra con tu usuario del equipo.</p>
  <form class="oa-form" data-do="login" novalidate>
    <label class="oa-field"><span>Usuario</span><input name="username" autocomplete="username" required maxlength="40"></label>
    <label class="oa-field"><span>Contraseña</span><input name="password" type="password" autocomplete="current-password" required maxlength="128"></label>
    <label class="oa-field" data-mfa hidden><span>Código de verificación</span><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="20"></label>
    <p class="oa-message" role="alert" data-message></p>
    <button type="submit" class="k-btn k-btn--primary">Entrar</button>
  </form>
</section>`,
    { state: 'login' },
  );
}

export function notAllowedPage(user, reason) {
  return layout(
    'Esta cuenta no puede conectar asistentes',
    `<section class="oa-card oa-card--warn">
  <h1>Esta cuenta no puede conectar asistentes</h1>
  <p>${esc(reason)}</p>
  <p class="oa-muted">Entraste como <strong>${esc(user.name || user.username)}</strong>.</p>
  <p class="oa-message" role="alert" data-message></p>
  <button type="button" class="k-btn" data-do="switch">Usar otra cuenta</button>
</section>`,
    { state: 'denied' },
  );
}

// `scopes`: [{ key, label, kind, personal, brands: [ids] }]; `brands`: [{ id, name }].
export function consentPage({ request, csrf, client, redirectHost, loopback, user, brands, scopes, checked }) {
  const brandList = brands
    .map(
      (b, i) =>
        `<label class="oa-option"><input type="radio" name="brand" value="${esc(b.id)}"${i === 0 ? ' checked' : ''} required><span>${esc(b.name)}</span></label>`,
    )
    .join('');
  const group = (kind, title, hint) => {
    const items = scopes.filter(s => s.kind === kind);
    if (!items.length) return '';
    return `<fieldset class="oa-group">
    <legend>${esc(title)}</legend>
    <p class="oa-muted">${esc(hint)}</p>
    ${items
      .map(
        s =>
          `<label class="oa-option oa-option--scope"><input type="checkbox" name="scope" value="${esc(s.key)}" data-brands="${esc(s.brands.join(' '))}"${checked.includes(s.key) ? ' checked' : ''}><span>${esc(s.label)}${s.personal ? ' <span class="k-chip k-chip--warn">Datos personales</span>' : ''}</span></label>`,
      )
      .join('')}
  </fieldset>`;
  };
  return layout(
    'Permitir el acceso',
    `<section class="oa-card">
  <p class="oa-eyebrow">Paso 2 de 2</p>
  <h1>¿Permitir que este asistente use el CRM?</h1>
  <div class="oa-app">
    <p class="oa-app__name">${esc(client.name)}</p>
    <p class="oa-muted">Nombre que declara la aplicación; el CRM no lo comprueba.</p>
    <dl class="oa-facts">
      ${client.host ? `<div><dt>Identidad publicada en</dt><dd>${esc(client.host)}</dd></div>` : ''}
      ${client.uri ? `<div><dt>Sitio que declara</dt><dd>${esc(client.uri)}</dd></div>` : ''}
      <div><dt>Regresará a</dt><dd>${esc(redirectHost)}</dd></div>
    </dl>
    ${
      loopback
        ? '<p class="k-notice k-notice--warn">La aplicación regresa a un programa de esta misma computadora. Permítelo sólo si tú acabas de iniciar la conexión desde un programa en este equipo.</p>'
        : ''
    }
  </div>
  <p>Entraste como <strong>${esc(user.name || user.username)}</strong>. El asistente podrá hacer, en UNA marca, sólo lo que marques aquí y sólo mientras tú sigas teniendo ese acceso. Lo puedes desconectar cuando quieras en Ajustes → Asistentes conectados.</p>
  <form class="oa-form" data-do="consent" novalidate>
    <fieldset class="oa-group">
      <legend>Marca</legend>
      <div class="oa-options">${brandList}</div>
    </fieldset>
    ${group('read', 'Puede consultar', 'Lectura. Lo marcado como datos personales deja ver nombres, teléfonos, correos o mensajes.')}
    ${group('write', 'Puede cambiar', 'Escritura. Los cambios quedan a tu nombre en la bitácora.')}
    <p class="oa-message" role="alert" data-message></p>
    <div class="oa-actions">
      <button type="button" class="k-btn" data-do="deny">Cancelar</button>
      <button type="submit" class="k-btn k-btn--primary">Permitir</button>
    </div>
  </form>
</section>`,
    { state: 'consent', request, csrf },
  );
}
