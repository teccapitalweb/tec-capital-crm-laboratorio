// Subida única de archivos (server/lib/upload.mjs, media-sniff.mjs, media-limits.mjs): tipo real por la firma,
// archivos falsos rechazados, límites por clase y por uso, nombre seguro y almacenamiento por marca sin salir de su
// carpeta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discard, load, receive, safeName, store, storedPath } from '../server/lib/upload.mjs';
import { sniff } from '../server/lib/media-sniff.mjs';
import { MEDIA_LIMITS, limitFor } from '../server/lib/media-limits.mjs';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32, 2)]);
const PDF = Buffer.from('%PDF-1.7\n1 0 obj\n');
const GIF = Buffer.from('GIF89a' + 'x'.repeat(20));
const input = (name, type, buffer) => ({ name, type, base64: buffer.toString('base64') });
const code = c => e => e.code === c;

test('firma del archivo: el tipo real se lee de su contenido', () => {
  assert.deepEqual(sniff(PNG), { mime: 'image/png', ext: 'png', kind: 'image' });
  assert.deepEqual(sniff(JPG), { mime: 'image/jpeg', ext: 'jpg', kind: 'image' });
  assert.deepEqual(sniff(PDF), { mime: 'application/pdf', ext: 'pdf', kind: 'document' });
  assert.equal(sniff(Buffer.from('<html><script>')), null);
  assert.equal(sniff(Buffer.alloc(0)), null);
});

test('recepción: tipo real, archivos falsos, límites y nombre seguro', () => {
  const ok = receive(input('C:\\fotos\\Flyer de aves.PNG', 'image/png', PNG));
  assert.equal(ok.mime, 'image/png');
  assert.equal(ok.filename, 'Flyer de aves.png');
  assert.equal(ok.size, PNG.length);
  assert.equal(receive(input('foto.jpeg', 'image/jpg', JPG)).filename, 'foto.jpg');
  assert.equal(receive(input('temario', '', PDF)).filename, 'temario.pdf');
  // la extensión o el tipo declarado no coinciden con el contenido
  assert.throws(() => receive(input('flyer.png', 'image/png', PDF)), code('upload_type_mismatch'));
  assert.throws(() => receive(input('temario.pdf', 'application/pdf', PNG)), code('upload_type_mismatch'));
  assert.throws(() => receive(input('temario.pdf', '', PNG)), code('upload_type_mismatch'));
  // un formato desconocido, o uno conocido que este uso no admite
  assert.throws(
    () => receive(input('pagina.png', 'image/png', Buffer.from('<svg onload=x>'))),
    code('upload_type_not_allowed'),
  );
  assert.throws(
    () => receive(input('a.gif', 'image/gif', GIF), { mimes: ['image/png', 'image/jpeg'] }),
    code('upload_type_not_allowed'),
  );
  assert.throws(
    () => receive(input('a.pdf', 'application/pdf', PDF), { allow: ['image'] }),
    code('upload_type_not_allowed'),
  );
  assert.throws(() => receive({ name: 'x' }), code('upload_missing'));
  // tamaño por uso: el encabezado de una plantilla no pasa de 4 MB aunque una imagen admita 5
  assert.equal(limitFor('image'), MEDIA_LIMITS.image);
  assert.equal(limitFor('image', { purpose: 'templateHeader' }), 4 * 1024 * 1024);
  assert.equal(limitFor('document', { purpose: 'templateHeader', channel: 1024 }), 1024);
  const big = Buffer.concat([PNG, Buffer.alloc(4 * 1024 * 1024)]);
  assert.throws(
    () => receive(input('big.png', 'image/png', big), { purpose: 'templateHeader' }),
    code('upload_too_large'),
  );
  assert.equal(receive(input('big.png', 'image/png', big)).size, big.length);
  assert.equal(safeName('../../etc/passwd', 'png'), 'passwd.png');
  assert.equal(safeName('   ', 'pdf'), 'archivo.pdf');
});

test('almacenamiento por marca, sin salir de su carpeta', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'crm-upload-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = receive(input('flyer.png', 'image/png', PNG));
  const name = await store(dir, { area: 'library', brandId: 'globalvet' }, file);
  assert.match(name, /^globalvet\/[a-f0-9-]{36}\.png$/);
  assert.deepEqual(await load(dir, 'library', name), PNG);
  assert.equal((await stat(storedPath(dir, 'library', name))).size, PNG.length);
  await assert.rejects(store(dir, { area: 'library', brandId: '../otra' }, file), code('invalid_brand'));
  assert.throws(() => storedPath(dir, 'library', '../laboratorio.sqlite'), code('not_found'));
  await discard(dir, 'library', name);
  await assert.rejects(readFile(storedPath(dir, 'library', name)));
});
