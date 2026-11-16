// Envío de plantillas por API (docs/PLAN_API_ENVIO.md; incremento I-8): el estado de un envío sólo lo ve la llave
// que lo hizo, y los avisos de Meta se publican con la llave del envío. Las dos cosas buscan en api_requests por la
// entidad (`entity_kind='send'`, `entity_id` = el envío): este índice evita recorrer la tabla. Aditiva: no cambia filas.
export default {
  name: 'api/0002-send-lookup',
  after: [],
  up(db) {
    db.exec('CREATE INDEX api_requests_entity ON api_requests(entity_kind, entity_id)');
  },
};
