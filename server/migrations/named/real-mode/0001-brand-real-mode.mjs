// Modo real por marca (docs/PLAN_MODO_REAL.md). Una fila por marca que lo haya tocado; sin fila, la marca sigue en
// laboratorio, igual que hoy.
//
//   brand_real_mode   enabled (0 por omisión: laboratorio), payment_instructions (cómo pagar, escrito por la marca;
//                     vacío = «un asesor te dará los datos»), revision (para expectedRevision), quién y cuándo.
export default {
  name: 'real-mode/0001-brand-real-mode',
  after: [], // tabla propia; sólo referencia brands y users (escalera)
  up(db) {
    db.exec(`
      CREATE TABLE brand_real_mode(
        brand_id TEXT PRIMARY KEY REFERENCES brands(id),
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        payment_instructions TEXT NOT NULL DEFAULT '',
        revision INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT REFERENCES users(id),
        updated_at INTEGER
      );`);
  },
};
