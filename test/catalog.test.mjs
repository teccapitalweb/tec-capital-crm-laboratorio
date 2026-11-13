import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../server/database.mjs';

test('la ampliación del catálogo conserva cursos editados y conversaciones anteriores', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'crm-catalog-migration-'));
  let db;
  try {
    db = openDatabase(directory);
    db.prepare("UPDATE courses SET price_cents=67000,version=4 WHERE id='aves'").run();
    db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?,?)').run(
      'test-user',
      'migration-test',
      'Prueba migración',
      'not-a-real-password',
      'customer',
      199999,
      1,
      1,
    );
    db.prepare(
      'INSERT INTO conversations(id,customer_id,brand_id,course_id,channel,created_at,updated_at) VALUES(?,?,?,?,?,?,?)',
    ).run('test-chat', 'test-user', 'globalvet', 'aves', 'whatsapp', 1, 1);
    db.exec("DELETE FROM courses WHERE id IN ('nutricion','estetica','rutinas'); PRAGMA user_version=1;");
    db.close();
    db = openDatabase(directory);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM courses').get().n, 6);
    assert.equal(db.prepare("SELECT price_cents FROM courses WHERE id='aves'").get().price_cents, 67000);
    assert.equal(db.prepare("SELECT version FROM courses WHERE id='aves'").get().version, 4);
    assert.equal(
      db.prepare("SELECT customer_id FROM conversations WHERE id='test-chat'").get().customer_id,
      'test-user',
    );
    db.close();
    db = openDatabase(directory);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM courses').get().n, 6);
  } finally {
    db?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
