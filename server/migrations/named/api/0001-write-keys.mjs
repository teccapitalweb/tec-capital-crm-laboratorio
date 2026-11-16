// Llaves de escritura de la API v1 (docs/PLAN_API_ESCRITURA.md; diseño de identidad y API §4.13; conciliación técnica,
// tabla de datos y fila 47).
//
//   api_keys          gana caducidad (`expires_at`; obligatoria si la llave escribe), la llave de la que salió al rotar
//                     (`rotated_from`) y, para el envío de plantillas que llegará después, el número por omisión y el
//                     tope diario de envíos (`default_number_id`, `daily_send_limit`; hoy sin uso). Ninguna llave que ya
//                     existía gana permisos: sus `scopes` no se tocan.
//   webhook_endpoints `api_key_id`: el destino que cree una llave (todavía sin ruta) se borrará con ella; NULL = de pantalla.
//   api_requests      una fila por escritura: idempotencia (clave y huella del cuerpo, respuesta mínima guardada para
//                     repetirla), resultado y registro. Nunca guarda la llave, cuerpos ni datos personales; la ruta va
//                     como patrón, no como dirección.
import { addColumn } from '../../named.mjs';

export default {
  name: 'api/0001-write-keys',
  after: [],
  up(db) {
    addColumn(db, 'api_keys', 'expires_at', 'INTEGER');
    addColumn(db, 'api_keys', 'daily_send_limit', 'INTEGER');
    addColumn(db, 'api_keys', 'default_number_id', 'TEXT');
    addColumn(db, 'api_keys', 'rotated_from', 'TEXT');
    addColumn(db, 'webhook_endpoints', 'api_key_id', 'TEXT');
    db.exec(`
      CREATE INDEX api_keys_prefix ON api_keys(prefix);
      CREATE TABLE api_requests(
        id TEXT PRIMARY KEY,
        key_id TEXT NOT NULL REFERENCES api_keys(id),
        brand_id TEXT NOT NULL REFERENCES brands(id),
        actor_id TEXT REFERENCES users(id),
        method TEXT NOT NULL,
        route TEXT NOT NULL,
        idem_key TEXT,
        request_hash TEXT,
        status INTEGER NOT NULL,
        code TEXT,
        entity_kind TEXT,
        entity_id TEXT,
        units INTEGER NOT NULL DEFAULT 1,
        response TEXT,
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX api_requests_idem ON api_requests(key_id, idem_key) WHERE idem_key IS NOT NULL;
      CREATE INDEX api_requests_key ON api_requests(key_id, created_at);
      CREATE INDEX api_requests_created ON api_requests(created_at);
    `);
  },
};
