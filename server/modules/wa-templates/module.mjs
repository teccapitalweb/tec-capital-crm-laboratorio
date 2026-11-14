// Plantillas completas de WhatsApp (docs/PLAN_PLANTILLAS_COMPLETAS.md; diseño de difusiones §6; conciliación, filas
// 13, 36, 44, 45 y D-3).
//
// Una plantilla aprobada por Meta es lo único que se puede escribir a una persona con la ventana de 24 h cerrada. Este
// módulo es su dueño: la definición completa (encabezado de texto, imagen o documento; cuerpo con datos; pie; botones de
// respuesta rápida, enlace o teléfono), su envío a revisión de Meta, la sincronización y la ADOPCIÓN POR LOTE de las que
// ya existen en la cuenta, los avisos de Meta (estado, calidad, categoría), editar, duplicar y dar de baja, y su envío
// desde el chat. server/whatsapp.mjs le delega las rutas publicadas y el armado de lo que sale a Meta.
//
// Rutas publicadas (se amplían, no se rompen; las atiende este módulo por delegación de server/whatsapp.mjs):
//   GET    /api/whatsapp/templates[?brand&q&status&category&language&archived&limit&offset]
//   GET    /api/whatsapp/templates/:id                    {template}
//   POST   /api/whatsapp/templates/validate               formato del editor → {components, warnings, preview}
//   POST   /api/whatsapp/templates                        formato del editor o el de siempre → 201 {template}
//   PATCH  /api/whatsapp/templates/:id                    {…, expectedRevision} → {template}
//   POST   /api/whatsapp/templates/:id/submit             → {template}
//   POST   /api/whatsapp/templates/:id/duplicate          {name, language?, brandId?, clientRef} → 201 {template}
//   POST   /api/whatsapp/templates/:id/ack                «enterado» del cambio de categoría
//   POST   /api/whatsapp/templates/:id/restore            {expectedRevision}
//   DELETE /api/whatsapp/templates/:id[?meta=1]           {ok, result:'archived'|'deleted'}
//   POST   /api/whatsapp/templates/sync                   {found, updated, remote}
//   GET    /api/whatsapp/templates/remote?q&offset&limit  plantillas de la cuenta que el CRM no usa (paginadas)
//   POST   /api/whatsapp/templates/adopt                  forma de siempre, o {brandId, items:[{name,language,variables?}], purpose?}
//   GET|POST /api/conversations/:id/wa-templates          como siempre (equipo de la marca, desde el chat)
// Propias del módulo:
//   POST   /api/wa-templates/files                        {brandId, file:{name,type,base64}, clientRef} → 201 {file}
//   GET    /api/wa-templates/files/:id                    el archivo, con sesión y alcance por marca
//
// Permiso: templates.manage en la marca (hoy sólo administración). Ninguna red dentro de una transacción.
import { randomUUID } from 'node:crypto';
import * as copy from '../../reply-copy.mjs';
import { transaction } from '../../database.mjs';
import { templateParams } from '../../lib/variables.mjs';
import { load, receive, serve, store, storedPath, discard } from '../../lib/upload.mjs';
import { createRepo } from './repo.mjs';
import {
  CATEGORIES,
  CHAT_KEYS,
  HEADER_FILE_TYPES,
  LANGUAGES,
  SENDABLE,
  chatCanFill,
  definitionOf,
  fromEditor,
  fromMeta,
  needsMapping,
  preview,
  rejectText,
  statusLabel,
  submitProblems,
  toEditor,
  toMetaArgs,
  varsOf,
} from './definition.mjs';

const PERM = 'templates.manage';

// La cuenta de WhatsApp es de toda la instalación, no de una marca: lo que la lee o la cambia entera (sincronizar, ver
// y adoptar lo que hay en Meta) pide el permiso en TODAS las marcas. Tenerlo en una sola no alcanza.
export function requireAccountWide(access, user, perm, brandIds) {
  access.require(user, perm);
  for (const id of brandIds) access.require(user, perm, id);
}
const NAME = /^[a-z0-9_]{1,128}$/;
const UUID = /^[a-f0-9-]{36}$/;
const REF = /^[a-zA-Z0-9-]{16,100}$/;
const PAGE = 50;
const BATCH = 100;
const REMOTE_MAX = 6000;
const PER_HOUR = 100;
const HOUR = 3_600_000;
const STATUS_OF = { reinstated: 'approved', pending_deletion: 'pending_deletion' };
const EVENT_TYPES = {
  'plantilla.estado': {
    title: 'Meta cambió el estado de una plantilla',
    entity: 'wa_template',
    payload: 'name, language, status, previous, reason',
  },
  'plantilla.calidad': {
    title: 'Meta cambió la calidad de una plantilla',
    entity: 'wa_template',
    payload: 'name, language, quality, previous',
  },
  'plantilla.categoria': {
    title: 'Meta cambió la categoría de una plantilla',
    entity: 'wa_template',
    payload: 'name, language, category, previous',
  },
};
const text = (v, max) =>
  typeof v === 'string'
    ? v
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .trim()
        .slice(0, max)
    : '';
const slots = body =>
  [...new Set([...String(body).matchAll(/\{\{(\d+)\}\}/g)].map(x => Number(x[1])))].sort((a, b) => a - b);

export default {
  name: 'wa-templates',
  create(host) {
    const { db, fail, audit, json, body, rate } = host;
    const { crm, connectors, events, whatsapp } = host.services;
    const repo = createRepo(db);
    const env = process.env;
    const now = () => Date.now();
    const meta = () => connectors.adapters.channel.meta;
    // La cuenta vigente: META_WABA_ID o '' (sin cuenta: el laboratorio).
    const waba = () =>
      /^\d{5,25}$/.test(String(env.META_WABA_ID || '').trim()) ? String(env.META_WABA_ID).trim() : '';
    const refs = new Map(); // clientRef → resultado (altas, copias y subidas repetidas no duplican; una instancia)
    const submits = []; // instantes de los envíos a revisión de la última hora (regla de Meta: 100 por hora)

    events.registerTypes(EVENT_TYPES, { entities: { wa_template: 'Plantilla de WhatsApp' } });
    const emit = (brandId, id) => {
      try {
        host.realtime.emit('templates.changed', { brandId, data: { id } });
      } catch {}
    };
    const remember = (user, clientRef, value) => {
      if (!clientRef) return;
      refs.set(user.id + ':' + clientRef, value);
      if (refs.size > 2000) refs.delete(refs.keys().next().value);
    };
    const recalled = (user, clientRef) => (clientRef ? refs.get(user.id + ':' + clientRef) : undefined);
    const refOf = input => {
      const ref = input?.clientRef === undefined || input?.clientRef === null ? '' : String(input.clientRef);
      if (ref && !REF.test(ref)) throw fail(400, 'Referencia no válida.', { code: 'invalid_client_ref' });
      return ref;
    };

    // ---- vistas
    const brandName = id => repo.brandName(id)?.name || id;
    function view(row) {
      const def = definitionOf(row);
      const keys = def.body.vars.map(v => v.key);
      return {
        id: row.id,
        brandId: row.brand_id,
        brandName: brandName(row.brand_id),
        wabaId: row.waba_id,
        name: row.name,
        language: row.language,
        category: row.category,
        purpose: row.purpose,
        body: row.body,
        variables: keys.filter(k => k && Object.hasOwn(CHAT_KEYS, k)),
        status: row.status,
        statusLabel: statusLabel(row.status),
        statusDetail: row.status_detail,
        rejectReason: row.reject_reason,
        rejectText: row.status === 'rejected' ? rejectText(row.reject_reason) : null,
        quality: row.quality,
        prevCategory: row.prev_category,
        categoryChangedAt: row.category_changed_at,
        categoryAckAt: row.category_ack_at,
        submittedAt: row.submitted_at,
        approvedAt: row.approved_at,
        archivedAt: row.archived_at,
        copiedFrom: row.copied_from,
        metaId: row.meta_id,
        revision: row.revision,
        syncedAt: row.synced_at,
        updatedAt: row.updated_at,
        components: def,
        editor: toEditor(def),
        needsMapping: needsMapping(def),
        editable: ['draft', 'rejected'].includes(row.status) && !row.archived_at,
        preview: preview(def).body,
        message: preview(def),
      };
    }
    const files = brandId => id => {
      const f = repo.file(id, brandId);
      return f ? { id: f.id, filename: f.filename, mime: f.mime, size: f.size } : null;
    };
    const getRow = (id, user) => {
      const row = UUID.test(String(id || '')) ? repo.byId(String(id)) : null;
      if (!row) throw fail(404, 'Plantilla no encontrada.', { code: 'not_found' });
      host.access.require(user, PERM, row.brand_id);
      return row;
    };
    const legacyColumns = def => ({
      body: def.body.text,
      variables: JSON.stringify(def.body.vars.map(v => v.key).filter(Boolean)),
      components: JSON.stringify(def),
    });

    // ---- remotas (wa_account.remote_cache): lo que Meta tiene y el CRM no usa
    function account() {
      const id = waba();
      if (!id) return null;
      repo.ensureAccount(id, now(), now());
      return repo.account(id);
    }
    function remoteAll() {
      const acc = account();
      if (!acc?.remote_cache) return [];
      try {
        const list = JSON.parse(acc.remote_cache);
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    }
    // Las remotas que el CRM todavía no tiene (un borrador con el mismo nombre no cuenta: aún no existe en Meta).
    function remoteFree() {
      const known = new Set(
        repo
          .inAccount(waba())
          .filter(k => k.status !== 'draft')
          .map(k => k.name + '\u0000' + k.language),
      );
      return remoteAll().filter(r => !known.has(r.name + '\u0000' + r.language));
    }
    const remoteView = r => {
      const def = fromMeta(r.components);
      return {
        name: r.name,
        language: r.language,
        status: r.status,
        category: r.category,
        quality: r.quality ?? null,
        body: r.body,
        complex: Boolean(r.complex),
        supported: r.supported !== false,
        unsupported: r.unsupported || '',
        variables: slots(r.body).length,
        header: def.header.type,
        buttons: def.buttons.length,
        message: preview(def),
      };
    };

    function limits() {
      const acc = account();
      const t = now();
      while (submits.length && submits[0] < t - HOUR) submits.shift();
      return {
        count: repo.count(waba()).n + remoteFree().length,
        limit: acc?.template_limit ?? 250,
        submittedLastHour: submits.length,
        perHour: PER_HOUR,
      };
    }

    function status(user, url) {
      const visible = host.access.brandIds(user, PERM);
      const q = url.searchParams;
      const paged = ['brand', 'q', 'status', 'category', 'language', 'limit', 'offset', 'archived'].some(k => q.has(k));
      const brand = q.get('brand');
      if (brand && brand !== 'all') host.access.require(user, PERM, brand);
      const brands = brand && brand !== 'all' ? [brand] : visible;
      const limit = Math.max(1, Math.min(PAGE, Number(q.get('limit')) || PAGE));
      const offset = Math.max(0, Number(q.get('offset')) || 0);
      const page = paged
        ? repo.page(brands, {
            q: text(q.get('q') || '', 80),
            status: text(q.get('status') || '', 30),
            category: CATEGORIES.includes(q.get('category')) ? q.get('category') : '',
            language: LANGUAGES.includes(q.get('language')) ? q.get('language') : '',
            archived: q.get('archived') === '1',
            limit,
            offset,
          })
        : null;
      const rows = page ? page.rows : repo.all().filter(r => visible.includes(r.brand_id) && !r.archived_at);
      const free = remoteFree();
      const acc = account();
      return {
        wabaSet: Boolean(waba()),
        appSet: /^\d{5,25}$/.test(String(env.META_APP_ID || '').trim()),
        live: connectors.metaLive(),
        syncedAt: acc?.remote_at ?? null,
        keys: CHAT_KEYS,
        languages: LANGUAGES,
        sources: [
          ...Object.entries(CHAT_KEYS).map(([key, label]) => ({ key, label, chat: true })),
          { key: 'fijo.<nombre>', label: 'Valor fijo que se escribe al enviar', chat: false },
          { key: 'llamada.<nombre>', label: 'Valor que manda el sistema que llama por la API', chat: false },
          { key: 'cupon', label: 'Código de cupón', chat: false },
        ],
        brands: visible.map(id => ({ id, name: brandName(id) })),
        templates: rows.map(view),
        total: page ? page.total : rows.length,
        next: page && offset + rows.length < page.total ? String(offset + rows.length) : null,
        remote: free.slice(0, 200).map(remoteView),
        remoteTotal: free.length,
        limits: limits(),
        lastWebhookAt: repo.lastWebhook()?.t ?? null,
      };
    }

    // ---- alta, edición y copia
    function create(input, user, { copiedFrom = null } = {}) {
      const clientRef = refOf(input);
      const before = recalled(user, clientRef);
      if (before) return { template: view(repo.byId(before)), duplicate: true };
      const brandId = String(input.brandId || '');
      if (!repo.brandExists(brandId)) throw fail(400, 'Elige la marca de la plantilla.', { field: 'brandId' });
      host.access.require(user, PERM, brandId);
      const name = String(input.name || '')
        .trim()
        .toLowerCase();
      if (!NAME.test(name))
        throw fail(
          400,
          'El nombre de la plantilla va en minúsculas, sin espacios ni acentos: letras, números y guion bajo (por ejemplo aviso_novedad).',
          { field: 'name' },
        );
      const language = LANGUAGES.includes(input.language) ? input.language : 'es_MX';
      const category = input.category === 'marketing' ? 'marketing' : 'utility';
      const purpose = input.purpose === 'notice' ? 'notice' : 'manual';
      const { definition, warnings } = fromEditor({ ...input, category }, { files: files(brandId) });
      const id = randomUUID();
      const t = now();
      transaction(db, () => {
        if (repo.taken(name, language, waba())) throw fail(409, 'Ya existe una plantilla con ese nombre e idioma.');
        repo.insert({
          id,
          brandId,
          wabaId: waba(),
          name,
          language,
          category,
          purpose,
          ...legacyColumns(definition),
          status: 'draft',
          metaId: null,
          rejectReason: '',
          quality: null,
          copiedFrom,
          approvedAt: null,
          userId: user.id,
          at: t,
          syncedAt: null,
        });
      });
      remember(user, clientRef, id);
      audit(user, 'whatsapp.template.created', id);
      emit(brandId, id);
      return { template: view(repo.byId(id)), warnings };
    }

    function update(id, input, user) {
      const row = getRow(id, user);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== row.revision)
        throw fail(409, 'La plantilla cambió. Recarga la pantalla.', { code: 'stale_record' });
      const content = ['header', 'body', 'footer', 'buttons', 'samples', 'fallbacks', 'category'].some(k => k in input);
      let def = definitionOf(row);
      let category = row.category;
      let warnings = [];
      if (content) {
        const editable = ['draft', 'rejected'].includes(row.status) && !row.archived_at;
        const onlyOwn = !['header', 'body', 'footer', 'buttons', 'category'].some(k => k in input);
        if (!editable && !onlyOwn)
          throw fail(409, 'Sólo se cambia el contenido de un borrador o de una plantilla rechazada: duplícala.', {
            code: 'not_editable',
          });
        if (editable) {
          const current = toEditor(def);
          category =
            input.category === undefined ? row.category : input.category === 'marketing' ? 'marketing' : 'utility';
          ({ definition: def, warnings } = fromEditor(
            {
              header: input.header ?? current.header,
              body: input.body ?? current.body,
              footer: input.footer ?? current.footer,
              buttons: input.buttons ?? current.buttons,
              samples: { ...current.samples, ...(input.samples ?? {}) },
              fallbacks: { ...current.fallbacks, ...(input.fallbacks ?? {}) },
              category,
            },
            { files: files(row.brand_id) },
          ));
        } else {
          // lo propio del CRM en cualquier estado: la fuente, la muestra y el respaldo de cada dato
          def = mapVars(def, input);
        }
      }
      if (input.variables !== undefined || input.vars !== undefined) def = mapVars(def, input);
      const purpose = input.purpose === undefined ? row.purpose : input.purpose === 'notice' ? 'notice' : 'manual';
      const r = repo.update({
        id: row.id,
        category,
        purpose,
        ...legacyColumns(def),
        userId: user.id,
        at: now(),
        revision: row.revision,
      });
      if (!r.changes) throw fail(409, 'La plantilla cambió. Recarga la pantalla.', { code: 'stale_record' });
      audit(user, 'whatsapp.template.updated', row.id);
      emit(row.brand_id, row.id);
      return { template: view(repo.byId(row.id)), warnings };
    }
    // Indica qué dato llena cada variable de una plantilla (adoptada o aprobada): {variables:[…cuerpo…], samples, fallbacks}.
    function mapVars(def, input) {
      const copyDef = JSON.parse(JSON.stringify(def));
      if (Array.isArray(input.variables)) {
        if (input.variables.length !== copyDef.body.vars.length)
          throw fail(
            400,
            'Indica qué dato llena cada una de las ' + copyDef.body.vars.length + ' variables de la plantilla.',
          );
        input.variables.forEach((key, i) => {
          if (key !== null && !Object.hasOwn(CHAT_KEYS, key) && !/^(fijo|llamada)\.[a-z0-9_]{1,30}$|^cupon$/.test(key))
            throw fail(400, '«' + key + '» no es un dato disponible.');
          copyDef.body.vars[i].key = key;
        });
      }
      for (const v of [...copyDef.body.vars, ...(copyDef.header?.vars ?? [])]) {
        if (!v.key) continue;
        if (input.samples?.[v.key] !== undefined) v.sample = text(String(input.samples[v.key]), 200) || null;
        if (input.fallbacks?.[v.key] !== undefined) v.fallback = text(String(input.fallbacks[v.key]), 200) || null;
      }
      return copyDef;
    }

    function duplicate(id, input, user) {
      const clientRef = refOf(input);
      const before = recalled(user, clientRef);
      if (before) return { template: view(repo.byId(before)), duplicate: true };
      const row = getRow(id, user);
      const brandId = input.brandId ? String(input.brandId) : row.brand_id;
      const def = definitionOf(row);
      const editor = toEditor(def);
      // un archivo de muestra es de la biblioteca de su marca: en otra marca hay que elegirlo de nuevo
      if (brandId !== row.brand_id && editor.header.fileId) editor.header.fileId = null;
      const out = create(
        {
          brandId,
          name: input.name,
          language: input.language ?? row.language,
          category: row.category,
          purpose: row.purpose,
          ...editor,
        },
        user,
        { copiedFrom: row.id },
      );
      remember(user, clientRef, out.template.id);
      return out;
    }

    // ---- envío a revisión de Meta (asíncrono, fuera de transacción)
    async function submit(id, user) {
      const row = getRow(id, user);
      if (!['draft', 'rejected'].includes(row.status) || row.archived_at)
        throw fail(409, 'Esta plantilla ya se envió a Meta.', { code: 'already_submitted' });
      const def = definitionOf(row);
      const problems = submitProblems(def);
      if (problems.length) throw fail(400, problems[0], { code: 'incomplete' });
      const lim = limits();
      if (lim.submittedLastHour >= PER_HOUR)
        throw fail(429, 'Meta admite hasta 100 envíos a revisión por hora: espera un poco.', { code: 'rate_limited' });
      if (row.status === 'draft' && lim.count >= lim.limit)
        throw fail(409, `La cuenta llegó a su límite de ${lim.limit} plantillas en Meta: da de baja alguna.`, {
          code: 'template_limit',
        });
      const conflict = waba() && row.waba_id === '' ? repo.taken(row.name, row.language, waba()) : null;
      if (conflict && conflict.id !== row.id)
        throw fail(409, 'Ya existe una plantilla con ese nombre e idioma en la cuenta.', { code: 'duplicate' });
      let handle = null;
      if (def.header.type === 'image' || def.header.type === 'document') {
        const f = repo.file(def.header.fileId, row.brand_id);
        if (!f) throw fail(400, 'Falta el archivo de muestra del encabezado.', { code: 'incomplete' });
        const buffer = await load(host.dataDir, 'library', f.storage_name).catch(() => null);
        if (!buffer)
          throw fail(400, 'El archivo de muestra del encabezado ya no está disponible.', { code: 'incomplete' });
        handle = (await meta().uploadSample({ buffer, mime: f.mime })).handle;
      }
      const args = { name: row.name, language: row.language, category: row.category, ...toMetaArgs(def, { handle }) };
      let r;
      if (row.status === 'rejected' && row.meta_id && /^\d+$/.test(row.meta_id)) {
        await meta().editTemplate(row.meta_id, args);
        r = { metaId: row.meta_id, status: 'pending', category: row.category };
      } else r = await meta().createTemplate(args);
      submits.push(now());
      const t = now();
      repo.submitted({
        id: row.id,
        wabaId: waba() || row.waba_id,
        status: String(r.status || 'pending').toLowerCase(),
        metaId: r.metaId || null,
        category: r.category,
        handle,
        userId: user.id,
        at: t,
      });
      audit(user, 'whatsapp.template.submitted', row.id);
      emit(row.brand_id, row.id);
      return { template: view(repo.byId(row.id)) };
    }

    // ---- sincronizar: lee TODAS las páginas de Meta (red, fuera de transacción) y después aplica en una transacción
    async function sync(user) {
      const list = await meta().listTemplates();
      const id = waba();
      const t = now();
      let updated = 0;
      transaction(db, () => {
        const byKey = new Map(list.map(r => [r.name + '\u0000' + r.language, r]));
        for (const k of repo.inAccount(id)) {
          if (k.status === 'draft') continue; // un borrador aún no existe en Meta aunque coincida el nombre
          const r = byKey.get(k.name + '\u0000' + k.language);
          if (r) {
            repo.synced({
              id: k.id,
              wabaId: id || k.waba_id,
              status: r.status || k.status,
              metaId: r.metaId || null,
              reason: r.reason || '',
              quality: r.quality ?? null,
              category: r.category,
              at: t,
            });
            updated++;
          } else repo.missing(t, t, t, k.id);
        }
        if (id) {
          repo.ensureAccount(id, t, t);
          const cache = list.slice(0, REMOTE_MAX).map(r => ({
            metaId: r.metaId,
            name: r.name,
            language: r.language,
            status: r.status,
            category: r.category,
            quality: r.quality ?? null,
            reason: r.reason,
            body: r.body,
            complex: r.complex,
            supported: r.supported !== false,
            unsupported: r.unsupported || '',
            components: r.components,
          }));
          repo.saveRemote(JSON.stringify(cache), t, t, id);
        }
      });
      audit(user, 'whatsapp.template.sync', String(list.length));
      for (const b of host.access.brandIds(user, PERM)) emit(b, null);
      return { found: list.length, updated, remote: remoteFree().length };
    }

    function remotePage(url) {
      const q = text(url.searchParams.get('q') || '', 80).toLowerCase();
      const limit = Math.max(1, Math.min(BATCH, Number(url.searchParams.get('limit')) || PAGE));
      const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
      const list = remoteFree().filter(r => !q || r.name.toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
      const rows = list.slice(offset, offset + limit).map(remoteView);
      return {
        remote: rows,
        total: list.length,
        next: offset + rows.length < list.length ? String(offset + rows.length) : null,
      };
    }

    // ---- adoptar: la forma de siempre (una, para el chat) o por lote ({items}) sin tope fijo, paginada por quien llama
    function adoptOne(input, user) {
      const r = remoteFree().find(
        x => x.name === String(input.name || '') && x.language === String(input.language || ''),
      );
      if (!r)
        throw fail(
          404,
          'Esa plantilla no está en la última sincronización. Pulsa «Sincronizar con Meta» y vuelve a intentar.',
        );
      // la forma de siempre adopta para el chat, que sólo llena el texto principal; con encabezado de archivo o datos
      // fuera del cuerpo se usa la adopción por lote (la plantilla queda «falta indicar sus datos» o se le pone archivo)
      if (r.complex)
        throw fail(
          400,
          'Esa plantilla lleva un archivo o datos fuera del texto principal: adóptala desde la pantalla de plantillas.',
        );
      if (!CATEGORIES.includes(r.category)) throw fail(400, 'Sólo se usan plantillas de utilidad o de marketing.');
      const brandId = String(input.brandId || '');
      if (!repo.brandExists(brandId)) throw fail(400, 'Elige la marca de la plantilla.');
      host.access.require(user, PERM, brandId);
      const need = slots(r.body);
      const vars = (Array.isArray(input.variables) ? input.variables : []).map(String);
      if (need.some((n, i) => n !== i + 1))
        throw fail(400, 'Las variables de esa plantilla no están numeradas de corrido.');
      if (vars.length !== need.length || vars.some(k => !Object.hasOwn(CHAT_KEYS, k)))
        throw fail(400, 'Indica qué dato llena cada una de las ' + need.length + ' variables de la plantilla.');
      const [made] = insertAdopted([{ r, vars }], { brandId, purpose: input.purpose, user });
      if (!made) throw fail(409, 'Esa plantilla ya está en el CRM.');
      return { template: view(repo.byId(made)) };
    }
    function insertAdopted(list, { brandId, purpose, user }) {
      const t = now();
      const made = [];
      transaction(db, () => {
        for (const { r, vars } of list) {
          if (repo.taken(r.name, r.language, waba())) continue;
          const def = fromMeta(r.components, { body: vars });
          const id = randomUUID();
          repo.insert({
            id,
            brandId,
            wabaId: waba(),
            name: r.name,
            language: r.language,
            category: r.category,
            purpose: purpose === 'notice' ? 'notice' : 'manual',
            ...legacyColumns(def),
            status: r.status,
            metaId: r.metaId || null,
            rejectReason: r.reason || '',
            quality: r.quality ?? null,
            copiedFrom: null,
            approvedAt: SENDABLE.includes(r.status) ? t : null,
            userId: user.id,
            at: t,
            syncedAt: t,
          });
          made.push(id);
        }
      });
      for (const id of made) audit(user, 'whatsapp.template.adopted', id);
      if (made.length) emit(brandId, null);
      return made;
    }
    function adoptBatch(input, user) {
      const brandId = String(input.brandId || '');
      if (!repo.brandExists(brandId)) throw fail(400, 'Elige la marca de las plantillas.', { field: 'brandId' });
      host.access.require(user, PERM, brandId);
      const items = Array.isArray(input.items) ? input.items : [];
      if (!items.length) throw fail(400, 'Elige al menos una plantilla.', { field: 'items' });
      if (items.length > BATCH)
        throw fail(400, `Adopta hasta ${BATCH} plantillas por vez: el resto, en la siguiente página.`, {
          field: 'items',
        });
      const free = new Map(remoteFree().map(r => [r.name + '\u0000' + r.language, r]));
      const all = new Map(remoteAll().map(r => [r.name + '\u0000' + r.language, r]));
      const skipped = [];
      const existing = [];
      const todo = [];
      for (const item of items) {
        const key = String(item?.name || '') + '\u0000' + String(item?.language || '');
        const r = free.get(key);
        const label = { name: String(item?.name || ''), language: String(item?.language || '') };
        if (!r) {
          const known = all.has(key) ? repo.byName(label.name, label.language, waba()) : null;
          if (known)
            existing.push(view(known)); // adoptar otra vez no duplica: devuelve la que ya está
          else skipped.push({ ...label, reason: 'No está en la última sincronización.' });
          continue;
        }
        if (!r.supported) {
          skipped.push({ ...label, reason: r.unsupported || 'El CRM no la puede enviar.' });
          continue;
        }
        if (!CATEGORIES.includes(r.category)) {
          skipped.push({ ...label, reason: 'Sólo se usan plantillas de utilidad o de marketing.' });
          continue;
        }
        const vars = Array.isArray(item.variables)
          ? item.variables.map(k =>
              k && (Object.hasOwn(CHAT_KEYS, k) || /^(fijo|llamada)\.[a-z0-9_]{1,30}$|^cupon$/.test(k)) ? k : null,
            )
          : [];
        todo.push({ r, vars });
      }
      const made = insertAdopted(todo, { brandId, purpose: input.purpose, user });
      return {
        templates: made.map(id => view(repo.byId(id))),
        existing,
        skipped,
        remaining: remoteFree().length,
      };
    }

    // ---- baja suave, restaurar y «enterado»
    async function archive(id, user, { alsoInMeta = false } = {}) {
      const row = getRow(id, user);
      const campaign = repo.usedByCampaign(row.id);
      if (campaign)
        throw fail(409, `La usa la difusión «${campaign.title}», que está programada o en curso.`, {
          code: 'in_use',
          details: { campaignId: campaign.id },
        });
      if (row.status === 'draft' && !row.meta_id && !row.submitted_at && !repo.anyCampaign(row.id)) {
        repo.remove(row.id);
        audit(user, 'whatsapp.template.removed', row.id);
        emit(row.brand_id, row.id);
        return { ok: true, result: 'deleted' };
      }
      if (alsoInMeta) {
        host.requireAdmin(user);
        if (!row.meta_id) throw fail(409, 'Esta plantilla no existe en Meta.', { code: 'not_in_meta' });
        await meta().deleteTemplate({ name: row.name, metaId: row.meta_id });
      }
      const t = now();
      transaction(db, () => {
        repo.archive(t, user.id, t, row.id);
        if (alsoInMeta)
          repo.setStatus({ id: row.id, status: 'deleted', detail: 'Borrada desde el CRM', reason: null, at: t });
      });
      audit(user, alsoInMeta ? 'whatsapp.template.deleted' : 'whatsapp.template.archived', row.id);
      emit(row.brand_id, row.id);
      return { ok: true, result: 'archived' };
    }
    function restore(id, input, user) {
      const row = getRow(id, user);
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== row.revision)
        throw fail(409, 'La plantilla cambió. Recarga la pantalla.', { code: 'stale_record' });
      if (!row.archived_at) return { template: view(row) };
      if (['deleted', 'pending_deletion'].includes(row.status))
        throw fail(409, 'Se borró en Meta: no se puede restaurar. Duplícala con otro nombre.', {
          code: 'deleted_in_meta',
        });
      repo.restore(user.id, now(), row.id);
      audit(user, 'whatsapp.template.restored', row.id);
      emit(row.brand_id, row.id);
      return { template: view(repo.byId(row.id)) };
    }
    function ack(id, user) {
      const row = getRow(id, user);
      repo.ack(now(), user.id, now(), row.id);
      emit(row.brand_id, row.id);
      return { template: view(repo.byId(row.id)) };
    }

    // ---- avisos de Meta (template.update): síncrono, sin transacción propia ni red (corre dentro de la del canal)
    function applyWebhook(data) {
      const scope = String(data?.scopeId || '') || waba();
      const row =
        (data?.templateId && repo.byMeta(String(data.templateId), scope)) ||
        (data?.name && repo.byName(String(data.name), String(data.language || ''), scope)) ||
        null;
      if (!row) return 'plantilla que el CRM no usa';
      const t = now();
      const value = String(data.value || '');
      let type = null;
      let payload = null;
      if (data.field === 'status') {
        const status = STATUS_OF[value] ?? value;
        if (!status) return null;
        repo.setStatus({ id: row.id, status, detail: data.reason ?? null, reason: data.reason ?? null, at: t });
        type = 'plantilla.estado';
        payload = {
          name: row.name,
          language: row.language,
          status,
          previous: row.status,
          reason: data.reason ?? undefined,
        };
      } else if (data.field === 'quality') {
        repo.setQuality(value || null, t, t, row.id);
        type = 'plantilla.calidad';
        payload = { name: row.name, language: row.language, quality: value, previous: row.quality ?? undefined };
      } else if (data.field === 'category' && CATEGORIES.includes(value)) {
        repo.setCategory(value, t, t, row.id, value);
        type = 'plantilla.categoria';
        payload = { name: row.name, language: row.language, category: value, previous: row.category };
      } else return null;
      events.publish({
        type,
        brandId: row.brand_id,
        entityKind: 'wa_template',
        entityId: row.id,
        payload,
        source: 'wa-templates',
        dedupeKey: [type, row.id, value, t].join(':'),
      });
      emit(row.brand_id, row.id);
      return `plantilla ${row.name}: ${data.field} ${value}`;
    }
    connectors.on('template.update', applyWebhook, { order: 100, name: 'plantillas' });

    // ---- valores de cada dato (con la biblioteca común de variables) y lo que viaja a Meta
    // Contexto: la conversación (nombre, curso, edición, marca), `fixed` (fijo.<n>), `overrides` (llamada.<n>) y `coupon`.
    function resolve(row, { conversation = null, fixed = {}, overrides = {}, coupon = null } = {}) {
      const def = definitionOf(row);
      const c = conversation;
      const person = c ? repo.person(c.customer_id)?.name || '' : '';
      const course = c ? repo.course(c.course_id)?.title || '' : '';
      const edition = c?.edition_id ? repo.edition(c.edition_id)?.name || '' : '';
      const base = c
        ? {
            nombre: copy.firstName(person) || text(person, 40) || 'hola',
            curso: course,
            edicion: edition || course,
            marca: brandName(c.brand_id),
          }
        : {};
      const value = key => {
        if (Object.hasOwn(base, key)) return base[key];
        if (key === 'cupon') return coupon;
        const [kind, name] = key.split('.');
        if (kind === 'fijo') return fixed?.[name];
        if (kind === 'llamada') return overrides?.[name];
        return undefined;
      };
      const missing = [];
      // los datos del chat nunca faltan (si están vacíos salen como «—», como siempre); los demás, sí
      const fillVars = list => {
        const r = templateParams(
          list.map(v => v.key || ''),
          key => (key ? value(key) : undefined),
          {
            fallbacks: Object.fromEntries(list.filter(v => v.key && v.fallback).map(v => [v.key, v.fallback])),
            onMissing: key => (Object.hasOwn(CHAT_KEYS, key) ? '—' : null),
          },
        );
        list.forEach((v, i) => {
          if (r.params[i] === null) missing.push(v.key || '?');
        });
        return r.params.map(p => p ?? '—');
      };
      const params = fillVars(def.body.vars);
      let header = null;
      if (def.header.type === 'text' && def.header.vars.length)
        header = { type: 'text', params: fillVars(def.header.vars) };
      else if (def.header.type === 'image' || def.header.type === 'document') {
        if (!def.header.fileId) missing.push('archivo del encabezado');
        header = { type: def.header.type, fileId: def.header.fileId };
      }
      const buttons = [];
      def.buttons.forEach((b, index) => {
        if (b.type === 'url' && b.var) buttons.push({ index, subType: 'url', param: fillVars([b.var])[0] });
        else if (b.type === 'quick_reply')
          buttons.push({ index, subType: 'quick_reply', payload: `tpl:${row.id.slice(0, 8)}:${index}` });
        else if (b.type === 'copy_code' && b.code)
          buttons.push({ index, subType: 'copy_code', code: fillVars([b.code])[0] });
      });
      const filled = String(def.body.text).replace(/\{\{(\d+)\}\}/g, (_, n) => params[Number(n) - 1] ?? '');
      return {
        params,
        header,
        buttons,
        text: filled,
        missing,
        quickReplies: def.buttons.filter(b => b.type === 'quick_reply').map(b => b.text),
      };
    }
    const templateJson = (row, r, extra = {}) => ({
      name: row.name,
      language: row.language,
      params: r.params,
      templateId: row.id,
      ...(r.header ? { header: r.header } : {}),
      ...(r.buttons.length ? { buttons: r.buttons } : {}),
      ...extra,
    });

    // Lo que necesita el adaptador para un mensaje guardado como plantilla. Asíncrono (lee el archivo del encabezado):
    // lo llama server/whatsapp.mjs al salir, fuera de toda transacción.
    async function forSend(tpl) {
      const out = { name: tpl.name, language: tpl.language, params: Array.isArray(tpl.params) ? tpl.params : [] };
      if (tpl.header?.type === 'text') out.header = { type: 'text', params: tpl.header.params ?? [] };
      else if (tpl.header?.type === 'image' || tpl.header?.type === 'document') {
        const f = tpl.header.fileId ? repo.fileAny(String(tpl.header.fileId)) : null;
        const buffer = f ? await load(host.dataDir, 'library', f.storage_name).catch(() => null) : null;
        if (!buffer) throw fail(422, 'El archivo del encabezado de la plantilla ya no está disponible.');
        out.header = { type: tpl.header.type, media: { buffer, mime: f.mime, filename: f.filename } };
      }
      if (Array.isArray(tpl.buttons) && tpl.buttons.length) out.buttons = tpl.buttons;
      return out;
    }

    // ---- avisos del negocio con la ventana cerrada (docs/PLAN_PLANTILLAS_WHATSAPP.md §3)
    const noticeFor = (brandId, category) => repo.notice(brandId, category, waba()) ?? null;
    function ensureNotice(c, t) {
      const last = repo.lastCustomerAt(c.id).t || 0;
      const ref = 'wa-notice:' + c.id + ':' + last;
      const prev = repo.messageByRef(ref);
      if (prev) {
        if (prev.delivery_state === 'failed' && repo.retryNotice(prev.id).changes) host.broadcast('conversation', c.id);
        return false; // el aviso anterior falló: vuelve a salir
      }
      const made = transaction(db, () => {
        if (repo.messageByRef(ref)) return false;
        const r = resolve(t, { conversation: c });
        host.insertMessage(c, null, r.text, 'automation', ref, null, null, null, {
          category: t.category,
          template: templateJson(t, r, { notice: true }),
        });
        return true;
      });
      if (made) host.broadcast('conversation', c.id);
      return made;
    }

    // ---- desde el chat (equipo de la marca)
    const chatUsable = row => {
      const def = definitionOf(row);
      if (!varsOf(def).every(chatCanFill)) return false; // un dato que el chat no puede dar y sin respaldo
      if ((def.header.type === 'image' || def.header.type === 'document') && !def.header.fileId) return false;
      return !['video'].includes(def.header.type);
    };
    function chatTemplates(c, user) {
      crm.requireBrand(user, c.brand_id);
      if (!c.wa_number) return { templates: [] };
      return {
        templates: repo
          .sendable(c.brand_id, waba())
          .filter(chatUsable)
          .map(t => {
            const r = resolve(t, { conversation: c });
            const def = definitionOf(t);
            return {
              id: t.id,
              name: t.name,
              category: t.category,
              purpose: t.purpose,
              text: r.text,
              header: def.header.type === 'none' ? null : def.header.type,
              buttons: def.buttons.map(b => b.text || 'Copiar código'),
              flagged: t.status === 'flagged',
            };
          }),
      };
    }
    function sendTemplate(c, input, user) {
      crm.requireBrand(user, c.brand_id);
      if (!c.wa_number) throw fail(409, 'Las plantillas de WhatsApp son para conversaciones de un número real.');
      const clientRef = String(input.clientRef || '');
      if (!REF.test(clientRef)) throw fail(400, 'Referencia no válida.');
      const t = UUID.test(String(input.templateId || '')) ? repo.byId(String(input.templateId)) : null;
      if (!t || t.brand_id !== c.brand_id || !SENDABLE.includes(t.status) || t.archived_at || !chatUsable(t))
        throw fail(404, 'Esa plantilla no está aprobada para esta marca.');
      const ref = user.id + ':' + clientRef;
      const existing = repo.messageByRef(ref);
      if (existing) {
        if (existing.conversation_id !== c.id) throw fail(409, 'Referencia ya utilizada.');
        return { id: existing.id, duplicate: true };
      }
      const out = transaction(db, () => {
        const saved = repo.messageByRef(ref);
        if (saved) return { id: saved.id, duplicate: true };
        const current = host.accessConversation(c.id, user);
        if (current.status === 'resolved') throw fail(409, 'La conversación está cerrada.');
        if (current.assigned_to && current.assigned_to !== user.id && user.role !== 'admin')
          throw fail(409, 'Otro asesor está atendiendo esta conversación.');
        const r = resolve(t, { conversation: current });
        host.takeOver(current, user.id);
        return {
          id: host.insertMessage(current, user, r.text, 'agent', ref, null, null, null, {
            category: t.category,
            template: templateJson(t, r),
            buttons: r.quickReplies.length ? r.quickReplies : undefined,
          }),
          duplicate: false,
        };
      });
      if (!out.duplicate) audit(user, 'whatsapp.template.sent', out.id);
      host.broadcast('conversation', c.id);
      return out;
    }

    // ---- archivo de muestra del encabezado (biblioteca de la marca, subida única)
    async function upload(input, user) {
      const clientRef = refOf(input);
      const before = recalled(user, clientRef);
      if (before) return { file: before, duplicate: true };
      const brandId = String(input.brandId || '');
      if (!repo.brandExists(brandId)) throw fail(400, 'Elige la marca del archivo.', { field: 'brandId' });
      host.access.require(user, PERM, brandId);
      const file = receive(input.file, {
        allow: ['image', 'document'],
        mimes: [...HEADER_FILE_TYPES.image, ...HEADER_FILE_TYPES.document],
        purpose: 'templateHeader',
      });
      const storageName = await store(host.dataDir, { area: 'library', brandId }, file);
      const id = randomUUID();
      try {
        host.access.require(user, PERM, brandId);
        repo.insertFile(id, brandId, file.filename, file.mime, file.size, storageName, user.id, now());
      } catch (error) {
        await discard(host.dataDir, 'library', storageName);
        throw error;
      }
      const out = { id, filename: file.filename, mime: file.mime, size: file.size, kind: file.kind };
      remember(user, clientRef, out);
      audit(user, 'whatsapp.template.file', id);
      return { file: out };
    }
    async function serveFile(res, id, user) {
      const f = UUID.test(id) ? repo.fileAny(id) : null;
      if (!f || !f.storage_name) throw fail(404, 'Archivo no disponible.', { code: 'not_found' });
      host.requireStaff(user);
      crm.requireBrand(user, f.brand_id);
      await serve(res, {
        path: storedPath(host.dataDir, 'library', f.storage_name),
        mime: f.mime,
        filename: f.filename,
      });
    }

    // ---- rutas
    const requireAccount = user =>
      requireAccountWide(
        host.access,
        user,
        PERM,
        repo.brandIds().map(b => b.id),
      );
    async function handle(req, res, path, user, url = new URL(req.url, 'http://local')) {
      let x;
      if ((x = path.match(/^\/api\/conversations\/([a-f0-9-]+)\/wa-templates$/))) {
        if (user.role === 'customer') throw fail(403, 'Esta acción es para el equipo de atención.');
        const c = host.accessConversation(x[1], user);
        if (req.method === 'GET') {
          json(res, 200, chatTemplates(c, user));
          return true;
        }
        if (req.method === 'POST') {
          rate('send:' + user.id, 45);
          const out = sendTemplate(c, await body(req), user);
          json(res, out.duplicate ? 200 : 201, out);
          return true;
        }
        throw fail(405, 'Método no permitido.');
      }
      if (path === '/api/wa-templates/files' && req.method === 'POST') {
        rate('wa-file:' + user.id, 20);
        json(res, 201, await upload(await body(req), user));
        return true;
      }
      if ((x = path.match(/^\/api\/wa-templates\/files\/([a-f0-9-]{36})$/)) && req.method === 'GET') {
        await serveFile(res, x[1], user);
        return true;
      }
      if (path !== '/api/whatsapp/templates' && !path.startsWith('/api/whatsapp/templates/')) return false;
      if (path === '/api/whatsapp/templates' && req.method === 'GET') {
        host.access.require(user, PERM);
        json(res, 200, status(user, url));
        return true;
      }
      if (path === '/api/whatsapp/templates' && req.method === 'POST') {
        const out = create(await body(req), user);
        json(res, out.duplicate ? 200 : 201, out);
        return true;
      }
      if (path === '/api/whatsapp/templates/validate' && req.method === 'POST') {
        const input = await body(req);
        const brandId = String(input.brandId || '');
        host.access.require(user, PERM, brandId);
        const { definition, warnings } = fromEditor(input, { files: files(brandId) });
        json(res, 200, {
          components: definition,
          warnings,
          preview: preview(definition),
          problems: submitProblems(definition),
        });
        return true;
      }
      if (path === '/api/whatsapp/templates/sync' && req.method === 'POST') {
        requireAccount(user);
        rate('wa-sync:' + user.id, 12);
        json(res, 200, await sync(user));
        return true;
      }
      if (path === '/api/whatsapp/templates/remote' && req.method === 'GET') {
        requireAccount(user);
        json(res, 200, remotePage(url));
        return true;
      }
      if (path === '/api/whatsapp/templates/adopt' && req.method === 'POST') {
        requireAccount(user);
        const input = await body(req);
        json(res, 201, Array.isArray(input.items) ? adoptBatch(input, user) : adoptOne(input, user));
        return true;
      }
      if ((x = path.match(/^\/api\/whatsapp\/templates\/([a-f0-9-]{36})(?:\/(submit|duplicate|ack|restore))?$/))) {
        const [, id, action] = x;
        if (action === 'submit' && req.method === 'POST') {
          rate('wa-submit:' + user.id, 12);
          json(res, 200, await submit(id, user));
          return true;
        }
        if (action === 'duplicate' && req.method === 'POST') {
          const out = duplicate(id, await body(req), user);
          json(res, out.duplicate ? 200 : 201, out);
          return true;
        }
        if (action === 'ack' && req.method === 'POST') {
          json(res, 200, ack(id, user));
          return true;
        }
        if (action === 'restore' && req.method === 'POST') {
          json(res, 200, restore(id, await body(req), user));
          return true;
        }
        if (!action && req.method === 'GET') {
          json(res, 200, { template: view(getRow(id, user)) });
          return true;
        }
        if (!action && req.method === 'PATCH') {
          json(res, 200, update(id, await body(req), user));
          return true;
        }
        if (!action && req.method === 'DELETE') {
          json(res, 200, await archive(id, user, { alsoInMeta: url.searchParams.get('meta') === '1' }));
          return true;
        }
      }
      throw fail(404, 'Ruta de plantillas no encontrada.', { code: 'not_found' });
    }

    const api = { handle, resolve, forSend, noticeFor, ensureNotice, applyWebhook, sync, adopt: adoptBatch, view };
    whatsapp.useTemplates(api);
    return api;
  },
};
