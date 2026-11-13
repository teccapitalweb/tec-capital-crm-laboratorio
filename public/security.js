window.createSecurityUI = function ({ state, api, esc, icon, showModal, toast, refreshTeam }) {
  const $ = s => document.querySelector(s);
  let members = {};
  const groups = s => s.replace(/(.{4})/g, '$1 ').trim();

  async function mount() {
    const box = $('#sec-mfa');
    if (!box) return;
    try {
      const s = await api('/api/mfa');
      if (!$('#sec-mfa')) return;
      if (!s.available) {
        box.innerHTML = '';
        return;
      }
      box.innerHTML = `<h3 class="modal-section-title">Verificación en dos pasos</h3><div class="sec-top"><span class="ctc-tag ${s.enabled ? 'green' : 'amber'}">${s.enabled ? 'Activada' : 'Desactivada'}</span>${s.enabled ? `<small>${s.recoveryRemaining} código${s.recoveryRemaining === 1 ? '' : 's'} de recuperación disponible${s.recoveryRemaining === 1 ? '' : 's'}</small>` : ''}</div>
        <p class="crm-hint">${s.enabled ? 'Al iniciar sesión te pediremos, además de tu contraseña, el código de tu app de autenticación.' : 'Protege tu cuenta con un código temporal de una app como Google Authenticator, Microsoft Authenticator o 1Password. Recomendado, sobre todo para administración.'}</p>
        <div class="actions">${s.enabled ? `<button type="button" class="btn" data-action="sec-confirm" data-kind="recovery">Nuevos códigos de recuperación</button><button type="button" class="btn" data-action="sec-confirm" data-kind="disable">Desactivar</button>` : `<button type="button" class="btn primary" data-action="sec-setup">Activar verificación en dos pasos</button>`}</div>`;
    } catch (e) {
      box.innerHTML = `<p class="crm-hint">${esc(e.message)}</p>`;
    }
  }

  function codesModal(codes, title) {
    showModal(
      title,
      `<div class="sec-codes"><p class="crm-hint">Guarda estos códigos en un lugar seguro. Cada uno funciona <strong>una sola vez</strong> si pierdes tu teléfono. No los volveremos a mostrar.</p>
      <pre class="sec-code-list" id="sec-codes">${codes.map(esc).join('\n')}</pre>
      <div class="actions"><button type="button" class="btn" data-action="sec-copy">Copiar</button><button type="button" class="btn" data-action="sec-download">Descargar .txt</button></div>
      <label class="checkbox-field"><input type="checkbox" id="sec-saved"> Ya guardé mis códigos</label>
      <div class="actions"><button type="button" class="btn primary" data-action="sec-done">Listo</button></div></div>`,
    );
  }

  async function action(name, el) {
    try {
      if (name === 'sec-setup') {
        const r = await api('/api/mfa/setup', { method: 'POST', body: {} });
        showModal(
          'Activar verificación en dos pasos',
          `<div class="sec-setup"><ol class="sec-steps"><li>Abre tu app de autenticación y elige añadir una cuenta con <strong>clave de configuración</strong> (tipo basada en tiempo).</li><li>Escribe esta clave:<code class="sec-secret">${esc(groups(r.secret))}</code><a class="text-link" href="${esc(r.uri)}">Abrir en mi app de autenticación</a></li><li>Escribe aquí el código de 6 dígitos que muestra la app.</li></ol>
          <form id="sec-enable-form" class="form-grid"><label class="field">Código de 6 dígitos<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required></label><button class="btn primary" type="submit">Activar</button><div class="ops-feedback" role="status"></div></form></div>`,
        );
        return true;
      }
      if (name === 'sec-confirm') {
        const kind = el.dataset.kind;
        showModal(
          kind === 'disable' ? 'Desactivar verificación en dos pasos' : 'Nuevos códigos de recuperación',
          `<form id="sec-confirm-form" class="form-grid"><input type="hidden" name="kind" value="${esc(kind)}"><p class="crm-hint">${kind === 'disable' ? 'Tu cuenta volverá a depender sólo de la contraseña.' : 'Los códigos anteriores dejarán de funcionar.'} Confirma con tu contraseña y un código actual (o uno de recuperación).</p><label class="field">Contraseña<input name="password" type="password" autocomplete="current-password" required></label><label class="field">Código<input name="code" autocomplete="one-time-code" required maxlength="20"></label><button class="btn primary" type="submit">Confirmar</button><div class="ops-feedback" role="status"></div></form>`,
        );
        return true;
      }
      if (name === 'sec-copy') {
        await navigator.clipboard.writeText($('#sec-codes').textContent);
        toast('Códigos copiados');
        return true;
      }
      if (name === 'sec-download') {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(
          new Blob(
            ['Códigos de recuperación · TEC Capital\n(un solo uso cada uno)\n\n' + $('#sec-codes').textContent + '\n'],
            { type: 'text/plain;charset=utf-8' },
          ),
        );
        a.download = 'codigos-recuperacion.txt';
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        return true;
      }
      if (name === 'sec-done') {
        if (!$('#sec-saved')?.checked) {
          toast('Confirma que guardaste tus códigos.');
          return true;
        }
        $('#modal').close();
        await mount();
        return true;
      }
      if (name === 'sec-reset') {
        await api('/api/mfa/reset/' + el.dataset.id, { method: 'POST', body: {} });
        toast('Verificación en dos pasos restablecida. Esa persona deberá volver a iniciar sesión.');
        await loadMembers();
        await refreshTeam?.();
        return true;
      }
    } catch (e) {
      toast(e.message);
    }
    return true;
  }
  async function submit(form, input) {
    const feedback = form.querySelector('.ops-feedback');
    try {
      if (form.id === 'sec-enable-form') {
        const r = await api('/api/mfa/enable', { method: 'POST', body: { code: input.code } });
        codesModal(r.recoveryCodes, 'Verificación activada');
      }
      if (form.id === 'sec-confirm-form') {
        if (input.kind === 'disable') {
          await api('/api/mfa/disable', { method: 'POST', body: { password: input.password, code: input.code } });
          $('#modal').close();
          toast('Verificación en dos pasos desactivada');
          await mount();
        } else {
          const r = await api('/api/mfa/recovery-codes', {
            method: 'POST',
            body: { password: input.password, code: input.code },
          });
          codesModal(r.recoveryCodes, 'Nuevos códigos de recuperación');
        }
      }
    } catch (e) {
      if (feedback) feedback.textContent = e.message;
      toast(e.message);
    }
    return true;
  }

  async function loadMembers() {
    if (state.user?.role !== 'admin') {
      members = {};
      return;
    }
    try {
      members = (await api('/api/mfa/members')).members;
    } catch {
      members = {};
    }
  }
  function memberControls(m) {
    if (!['agent', 'admin'].includes(m.role) || m.disabled) return '';
    const on = Boolean(members[m.id]);
    return `<span class="ctc-tag ${on ? 'green' : ''}" title="${on ? 'Tiene verificación en dos pasos' : 'Sin verificación en dos pasos'}">${on ? '2 pasos' : 'Sin 2 pasos'}</span>${on && state.user.id !== m.id ? `<button class="btn" data-action="sec-reset" data-id="${esc(m.id)}">Restablecer 2 pasos</button>` : ''}`;
  }
  return { mount, action, submit, loadMembers, memberControls };
};
