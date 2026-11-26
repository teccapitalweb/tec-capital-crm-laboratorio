// Jornada simulada, bloque 2: los clientes pueden hablar con Claude en vez de con guiones fijos, con tope de gasto por
// jornada. Columnas aditivas en jornada_runs: `ai` (guiones | claude), el tope en centavos de dólar, y el uso (llamadas y
// tokens) para calcular lo gastado y parar al llegar al tope.
import { addColumn } from '../../named.mjs';

export default {
  name: 'jornada/0002-ai',
  after: ['jornada/0001-jornada'],
  up(db) {
    addColumn(db, 'jornada_runs', 'ai', "TEXT NOT NULL DEFAULT 'guiones'");
    addColumn(db, 'jornada_runs', 'ai_cap_cents', 'INTEGER NOT NULL DEFAULT 300');
    addColumn(db, 'jornada_runs', 'ai_calls', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'jornada_runs', 'ai_input_tokens', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'jornada_runs', 'ai_output_tokens', 'INTEGER NOT NULL DEFAULT 0');
    addColumn(db, 'jornada_runs', 'ai_note', "TEXT NOT NULL DEFAULT ''");
  },
};
