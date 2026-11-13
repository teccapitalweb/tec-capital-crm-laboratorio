import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { csvCell, csvLine } from '../server/contacts.mjs';

test('CSV: escapa comillas y saltos y neutraliza fórmulas de hoja de cálculo', () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('di "hola"'), '"di ""hola"""');
  assert.equal(csvCell('uno\ndos'), '"uno\ndos"');
  assert.equal(csvCell('a;=b'), '"a;=b"');
  assert.equal(csvCell('a\tb'), '"a\tb"');
  for (const f of ['=1+1', '+52 55', '-2', '@SUMA(A1)']) assert.ok(csvCell(f).startsWith("'"), f);
  assert.equal(csvCell(null), '');
  assert.equal(csvCell(0), '0');
  assert.equal(csvLine(['x', 1, '=y']), "x,1,'=y");
});

test('contactos: etiquetas, duplicados, fusión con vista previa y exportación', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-contacts-')),
    code = randomUUID(),
    password = 'Password-contacts-2026!';
  let logs = '';
  const server = spawn(process.execPath, ['server/index.mjs'], {
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: '0',
      DATA_DIR: dir,
      ADMIN_INVITE_CODE: code,
      APP_ORIGIN: '',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error(logs)), 10000);
    server.stderr.on('data', b => (logs += b));
    server.stdout.on('data', b => {
      const m = String(b).match(/http:\/\/127.0.0.1:\d+/);
      if (m) {
        clearTimeout(timer);
        resolve(m[0]);
      }
    });
    server.once('exit', () => {
      clearTimeout(timer);
      reject(Error(logs));
    });
  });
  t.after(async () => {
    if (server.exitCode === null)
      await new Promise(r => {
        server.once('exit', r);
        server.kill();
      });
    await rm(dir, { recursive: true, force: true });
  });
  async function raw(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST') {
    return fetch(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(path, cookie = '', body, method = body === undefined ? 'GET' : 'POST', expected = 200) {
    const r = await raw(path, cookie, body, method);
    const result = await r.json();
    assert.equal(r.status, expected, path + ': ' + JSON.stringify(result));
    return { ...result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  const reg = (username, inviteCode) =>
    call('/api/auth/register', '', { username, name: 'Prueba ' + username, password, inviteCode });
  const admin = await reg('admin', code),
    a = await reg('asesor.a'),
    b = await reg('asesor.b'),
    client = await reg('cliente');
  for (const [u, name, brandIds] of [
    [a, 'asesor.a', ['globalvet']],
    [b, 'asesor.b', ['odonteck']],
  ]) {
    const inv = await call('/api/team/invites', admin.cookie, { username: name, brandIds }, 'POST', 201);
    await call('/api/team/accept', u.cookie, { token: inv.token });
  }
  const db = () => new DatabaseSync(join(dir, 'laboratorio.sqlite'), { timeout: 5000 });
  const contact = async (brandId, name, phone = '', email = '', cookie = admin.cookie) =>
    (await call('/api/crm/contacts', cookie, { brandId, name, phone, email }, 'POST', 201)).id;
  const interest = (contactId, courseId, cookie = admin.cookie) =>
    call(
      '/api/crm/opportunities',
      cookie,
      { contactId, courseId, nextAction: 'Llamar', dueAt: Date.now() + 3600000 },
      'POST',
      201,
    );

  await t.test('etiquetas: permisos por marca, unicidad sin acentos, límites y asignación', async () => {
    await call('/api/crm/tags', client.cookie, undefined, 'GET', 403);
    await call('/api/crm/tags', '', undefined, 'GET', 401);
    await call('/api/crm/tags', client.cookie, { brandId: 'globalvet', name: 'X' }, 'POST', 403);
    await call('/api/crm/tags', b.cookie, { brandId: 'globalvet', name: 'VIP' }, 'POST', 404); // sin acceso a la marca
    await call('/api/crm/tags', a.cookie, { brandId: 'globalvet', name: '  ' }, 'POST', 400);
    await call('/api/crm/tags', a.cookie, { brandId: 'globalvet', name: 'VIP', color: 'rosa' }, 'POST', 400);
    const vip = (
      await call('/api/crm/tags', a.cookie, { brandId: 'globalvet', name: ' VIP  ', color: 'amber' }, 'POST', 201)
    ).tag;
    assert.equal(vip.name, 'VIP');
    await call('/api/crm/tags', a.cookie, { brandId: 'globalvet', name: 'vip' }, 'POST', 409);
    const ref = (await call('/api/crm/tags', a.cookie, { brandId: 'globalvet', name: 'Referido' }, 'POST', 201)).tag;
    const odon = (await call('/api/crm/tags', admin.cookie, { brandId: 'odonteck', name: 'VIP' }, 'POST', 201)).tag; // mismo nombre en otra marca sí se permite
    const ana = await contact('globalvet', 'Ana Tags');
    await call('/api/crm/contacts/' + ana + '/tags', a.cookie, { tagIds: [vip.id, ref.id, vip.id] }, 'PUT');
    await call('/api/crm/contacts/' + ana + '/tags', a.cookie, { tagIds: [odon.id] }, 'PUT', 400); // etiqueta de otra marca
    await call('/api/crm/contacts/' + ana + '/tags', b.cookie, { tagIds: [] }, 'PUT', 404); // contacto de otra marca
    await call(
      '/api/crm/contacts/' + ana + '/tags',
      a.cookie,
      { tagIds: Array.from({ length: 13 }, () => randomUUID()) },
      'PUT',
      400,
    );
    const list = await call('/api/crm/tags', a.cookie);
    assert.deepEqual([...list.links[ana]].sort(), [vip.id, ref.id].sort());
    assert.ok(list.tags.every(x => x.brand_id === 'globalvet'));
    assert.equal(list.tags.find(x => x.id === vip.id).count, 1);
    assert.ok(!(await call('/api/crm/tags', b.cookie)).tags.some(x => x.brand_id === 'globalvet'));
    await call('/api/crm/tags/' + vip.id, a.cookie, { name: 'Premium' }, 'PATCH', 403);
    assert.equal(
      (await call('/api/crm/tags/' + vip.id, admin.cookie, { name: 'Premium', color: 'violet' }, 'PATCH')).tag.name,
      'Premium',
    );
    await call('/api/crm/tags/' + vip.id, admin.cookie, { name: 'referido' }, 'PATCH', 409);
    await call('/api/crm/tags/' + ref.id, a.cookie, undefined, 'DELETE', 403);
    await call('/api/crm/tags/' + ref.id, admin.cookie, undefined, 'DELETE');
    assert.deepEqual((await call('/api/crm/tags', a.cookie)).links[ana], [vip.id]);
    await call('/api/crm/contacts/' + ana + '/tags', a.cookie, { tagIds: [] }, 'PUT');
    assert.equal((await call('/api/crm/tags', a.cookie)).links[ana], undefined);
  });

  await t.test('duplicados por teléfono, correo y nombre sin acentos; sólo marcas autorizadas', async () => {
    const p1 = await contact('globalvet', 'Dup Teléfono Uno', '+52 55 1234 9999'),
      p2 = await contact('globalvet', 'Otro Nombre', '(55) 1234-9999');
    const e1 = await contact('globalvet', 'Dup Correo Uno', '', 'Mismo@Correo.com'),
      e2 = await contact('globalvet', 'Dup Correo Dos', '', 'mismo@correo.com');
    const n1 = await contact('globalvet', 'María Núñez'),
      n2 = await contact('globalvet', 'maria nunez');
    await contact('globalvet', 'Corto', '123');
    await contact('globalvet', 'Corto Dos', '123');
    await contact('globalvet', 'Soloun');
    await contact('globalvet', 'Soloun'); // 123: muy corto; una palabra: se ignora
    const { groups } = await call('/api/crm/duplicates?brand=globalvet', a.cookie);
    const ids = g => g.contacts.map(c => c.id).sort();
    assert.ok(groups.some(g => g.reason === 'phone' && JSON.stringify(ids(g)) === JSON.stringify([p1, p2].sort())));
    assert.ok(groups.some(g => g.reason === 'email' && JSON.stringify(ids(g)) === JSON.stringify([e1, e2].sort())));
    assert.ok(groups.some(g => g.reason === 'name' && JSON.stringify(ids(g)) === JSON.stringify([n1, n2].sort())));
    assert.equal(groups.filter(g => g.contacts.some(c => ['Corto', 'Soloun'].includes(c.name))).length, 0);
    await call('/api/crm/duplicates?brand=globalvet', b.cookie, undefined, 'GET', 404);
    await call('/api/crm/duplicates?brand=nada', a.cookie, undefined, 'GET', 404);
    await call('/api/crm/duplicates', a.cookie, undefined, 'GET', 404);
  });

  await t.test(
    'fusión: sólo administración, reglas de seguridad, vista previa obligatoria y datos movidos',
    async () => {
      const keep = await contact('globalvet', 'Principal', '', ''),
        dup = await contact('globalvet', 'Duplicado', '5599887766', 'dup@correo.com');
      const tag = (
        await call('/api/crm/tags', admin.cookie, { brandId: 'globalvet', name: 'Para fusionar' }, 'POST', 201)
      ).tag;
      await call('/api/crm/contacts/' + dup + '/tags', admin.cookie, { tagIds: [tag.id] }, 'PUT');
      await call('/api/crm/contacts/' + dup + '/notes', admin.cookie, { text: 'Nota del duplicado' }, 'POST', 201);
      await interest(dup, 'aves');
      await call('/api/crm/contacts/merge-preview', a.cookie, { keepId: keep, mergeId: dup }, 'POST', 403);
      await call('/api/crm/contacts/merge', a.cookie, { keepId: keep, mergeId: dup }, 'POST', 403);
      await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: keep, mergeId: keep }, 'POST', 400);
      const other = await contact('odonteck', 'De otra marca');
      await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: keep, mergeId: other }, 'POST', 400);
      const preview = (
        await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: keep, mergeId: dup }, 'POST')
      ).plan;
      assert.equal(preview.canMerge, true);
      assert.deepEqual(preview.moves, { opportunities: 1, notes: 1, tags: 1 });
      assert.deepEqual(preview.fill, { phone: true, email: true });
      await call(
        '/api/crm/contacts/merge',
        admin.cookie,
        { keepId: keep, mergeId: dup, previewToken: 'x' },
        'POST',
        409,
      );
      await call(
        '/api/crm/contacts/' + keep,
        admin.cookie,
        { name: 'Principal Editado', phone: '', email: '' },
        'PATCH',
      ); // cambia después de la vista previa
      await call(
        '/api/crm/contacts/merge',
        admin.cookie,
        { keepId: keep, mergeId: dup, previewToken: preview.previewToken },
        'POST',
        409,
      );
      const fresh = (
        await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: keep, mergeId: dup }, 'POST')
      ).plan;
      const done = await call(
        '/api/crm/contacts/merge',
        admin.cookie,
        { keepId: keep, mergeId: dup, previewToken: fresh.previewToken },
        'POST',
      );
      assert.equal(done.keepId, keep);
      await call('/api/crm/contacts/' + dup, admin.cookie, undefined, 'GET', 404);
      const detail = await call('/api/crm/contacts/' + keep, admin.cookie);
      assert.equal(detail.contact.phone, '5599887766');
      assert.equal(detail.contact.email, 'dup@correo.com');
      assert.ok(detail.notes.some(n => n.text === 'Nota del duplicado'));
      assert.ok(detail.notes.some(n => /Fusión de contactos/.test(n.text)));
      const snap = await call('/api/crm', admin.cookie);
      assert.ok(snap.opportunities.some(o => o.contact_id === keep && o.course_id === 'aves'));
      assert.deepEqual((await call('/api/crm/tags', admin.cookie)).links[keep], [tag.id]);
      const d = db();
      try {
        assert.equal(
          d.prepare('SELECT count(*) n FROM contact_merges WHERE kept_id=? AND merged_id=?').get(keep, dup).n,
          1,
        );
        assert.equal(d.prepare('SELECT count(*) n FROM opportunities WHERE contact_id=?').get(dup).n, 0);
      } finally {
        d.close();
      }
      await call(
        '/api/crm/contacts/merge',
        admin.cookie,
        { keepId: keep, mergeId: dup, previewToken: fresh.previewToken },
        'POST',
        404,
      ); // repetir no duplica ni falla en silencio
    },
  );

  await t.test('fusión: bloquea intereses activos repetidos y perfiles vinculados', async () => {
    const c1 = await contact('globalvet', 'Conflicto Uno'),
      c2 = await contact('globalvet', 'Conflicto Dos');
    await interest(c1, 'nutricion');
    await interest(c2, 'nutricion');
    const plan = (await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: c1, mergeId: c2 }, 'POST'))
      .plan;
    assert.equal(plan.canMerge, false);
    assert.match(plan.problems[0], /mismo curso/);
    await call(
      '/api/crm/contacts/merge',
      admin.cookie,
      { keepId: c1, mergeId: c2, previewToken: plan.previewToken },
      'POST',
      409,
    );
    // perfil vinculado: se genera al abrir una conversación como cliente
    const conv = (await call('/api/conversations', client.cookie, { courseId: 'aves', channel: 'whatsapp' }))
      .conversation;
    assert.ok(conv.id);
    const linked = (await call('/api/crm', admin.cookie)).contacts.find(
      c => c.source_user_id && c.brand_id === 'globalvet',
    );
    assert.ok(linked);
    const manual = await contact('globalvet', 'Manual Para Perfil');
    const bad = (
      await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: manual, mergeId: linked.id }, 'POST')
    ).plan;
    assert.equal(bad.canMerge, false);
    assert.match(bad.problems.join(), /vinculado a un perfil/);
    const good = (
      await call('/api/crm/contacts/merge-preview', admin.cookie, { keepId: linked.id, mergeId: manual }, 'POST')
    ).plan;
    assert.equal(good.canMerge, true);
    await call(
      '/api/crm/contacts/merge',
      admin.cookie,
      { keepId: linked.id, mergeId: manual, previewToken: good.previewToken },
      'POST',
    );
    assert.ok((await call('/api/crm', admin.cookie)).contacts.some(c => c.id === linked.id && c.source_user_id));
  });

  await t.test(
    'exportación: sólo administración, protegida contra fórmulas y acotada por marca y etiqueta',
    async () => {
      await raw('/api/crm/export/contacts.csv', a.cookie).then(r => assert.equal(r.status, 403));
      await raw('/api/crm/export/contacts.csv').then(r => assert.equal(r.status, 401));
      const evil = await contact('globalvet', '=HYPERLINK("http://x")', '+525512341234', 'a@b.com');
      const tag = (await call('/api/crm/tags', admin.cookie, { brandId: 'globalvet', name: 'Exportar' }, 'POST', 201))
        .tag;
      await call('/api/crm/contacts/' + evil + '/tags', admin.cookie, { tagIds: [tag.id] }, 'PUT');
      const res = await raw('/api/crm/export/contacts.csv?brand=globalvet', admin.cookie);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/csv/);
      assert.match(res.headers.get('content-disposition'), /attachment; filename="contactos-\d{8}T\d{6}Z\.csv"/);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      const bytes = Buffer.from(await res.arrayBuffer());
      assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const text = bytes.toString('utf8').slice(1);
      assert.ok(text.startsWith('marca,nombre,telefono,correo,origen,etiquetas,intereses_activos'));
      assert.ok(text.includes('"\'=HYPERLINK(""http://x"")"'));
      assert.ok(text.includes("'+525512341234"));
      assert.ok(!text.includes('De otra marca'));
      const filtered = await (await raw('/api/crm/export/contacts.csv?tag=' + tag.id, admin.cookie)).text();
      assert.equal(filtered.trim().split('\r\n').length, 2);
      assert.ok(filtered.includes('Exportar'));
      await raw('/api/crm/export/contacts.csv?brand=nada', admin.cookie).then(r => assert.equal(r.status, 404));
      await raw('/api/crm/export/contacts.csv?tag=' + randomUUID(), admin.cookie).then(r =>
        assert.equal(r.status, 404),
      );
      const opp = await (await raw('/api/crm/export/opportunities.csv', admin.cookie)).text();
      assert.ok(opp.replace(/^\uFEFF/, '').startsWith('marca,contacto,curso,edicion,etapa,responsable,precio'));
      assert.ok(opp.split('\r\n').length > 2);
      const d = db();
      try {
        assert.ok(d.prepare("SELECT count(*) n FROM audit WHERE action LIKE 'export.%'").get().n >= 3);
      } finally {
        d.close();
      }
    },
  );
});
