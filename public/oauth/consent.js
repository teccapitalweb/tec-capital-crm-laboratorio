/* global document, window, fetch */
// Página de permiso de un asistente (docs/PLAN_MCP_OAUTH.md; la arma server/modules/mcp-oauth/page.mjs). Tres cosas:
//  · entrar con el usuario del equipo (las mismas rutas de siempre: /api/auth/login y, si hace falta, /api/auth/mfa);
//  · «Usar otra cuenta» (cerrar la sesión y volver a esta página);
//  · «Permitir» o «Cancelar»: manda la decisión con el código contra falsificación de la página y, con la respuesta,
//    vuelve a la aplicación del asistente. Todo texto se pone con textContent: nada se interpreta como HTML.
const page = document.getElementById('page');
const message = document.querySelector('[data-message]');
const say = text => {
  if (message) message.textContent = text || '';
};

async function send(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {}
  if (!response.ok) throw new Error(data?.error || 'No se pudo completar. Vuelve a intentarlo.');
  return data || {};
}

function busy(form, on) {
  for (const button of form.querySelectorAll('button')) button.disabled = on;
}

// Entrar (con verificación en dos pasos si la cuenta la tiene).
const login = document.querySelector('[data-do="login"]');
if (login) {
  let challenge = null;
  login.addEventListener('submit', async event => {
    event.preventDefault();
    say('');
    busy(login, true);
    try {
      if (challenge) {
        await send('/api/auth/mfa', { challenge, code: login.elements.code.value.trim() });
        window.location.reload();
        return;
      }
      const result = await send('/api/auth/login', {
        username: login.elements.username.value.trim(),
        password: login.elements.password.value,
      });
      if (result.mfaRequired) {
        challenge = result.challenge;
        const field = login.querySelector('[data-mfa]');
        field.hidden = false;
        field.querySelector('input').focus();
        say('Escribe el código de tu aplicación de verificación.');
        return;
      }
      window.location.reload();
    } catch (error) {
      say(error.message);
    } finally {
      busy(login, false);
    }
  });
}

// Usar otra cuenta: cerrar esta sesión y volver a pedir la entrada.
const other = document.querySelector('[data-do="switch"]');
if (other)
  other.addEventListener('click', async () => {
    try {
      await send('/api/auth/logout', {});
    } catch {}
    window.location.reload();
  });

// Permitir o cancelar.
const consent = document.querySelector('[data-do="consent"]');
if (consent) {
  const request = page.dataset.request;
  const csrf = page.dataset.csrf;
  // Sólo se pueden marcar los permisos que la persona puede dar en la marca elegida.
  const sync = () => {
    const brand = consent.querySelector('input[name="brand"]:checked')?.value || '';
    for (const box of consent.querySelectorAll('input[name="scope"]')) {
      const ok = box.dataset.brands.split(' ').includes(brand);
      box.disabled = !ok;
      if (!ok) box.checked = false;
      box.closest('label').classList.toggle('oa-option--off', !ok);
    }
  };
  consent.addEventListener('change', event => {
    if (event.target.name === 'brand') sync();
  });
  sync();
  const decide = async decision => {
    say('');
    busy(consent, true);
    try {
      const body = { request, csrf, decision };
      if (decision === 'allow') {
        body.brandId = consent.querySelector('input[name="brand"]:checked')?.value || '';
        body.scopes = [...consent.querySelectorAll('input[name="scope"]:checked')].map(box => box.value);
        if (!body.scopes.length) {
          say('Marca al menos un permiso.');
          busy(consent, false);
          return;
        }
      }
      const result = await send('/oauth/decision', body);
      say(decision === 'allow' ? 'Listo. Volviendo a la aplicación…' : 'Cancelado. Volviendo a la aplicación…');
      window.location.assign(result.redirect);
    } catch (error) {
      say(error.message);
      busy(consent, false);
    }
  };
  consent.addEventListener('submit', event => {
    event.preventDefault();
    decide('allow');
  });
  consent.querySelector('[data-do="deny"]').addEventListener('click', () => decide('deny'));
}
