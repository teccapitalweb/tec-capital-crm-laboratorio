// Contactos a escala (docs/PLAN_CONTACTOS_A_ESCALA.md): lo que necesita la lista paginada de la pantalla nueva.
//
// Una tabla de apoyo, `contact_search`, con una fila por contacto: la clave de búsqueda del nombre y del correo
// (minúsculas y sin acentos, server/lib/search-key.mjs), la fecha de alta, la última actividad y un número de cambio.
// Con ella la lista ordena por nombre, alta o actividad leyendo sólo las filas de una página de un índice por marca,
// y busca «jose» aunque el contacto se llame «José». El contacto no gana columnas: la tabla vive aparte y la
// mantienen disparadores, así que ningún módulo actual tiene que acordarse de ella.
//
// La última actividad es la fecha más reciente entre el contacto, sus intereses y sus conversaciones. `rev` crece con
// cada cambio que se ve en la lista (datos, etiquetas, consentimiento, intereses, conversación): el módulo
// `directory` lo lee para avisar en vivo qué filas cambiaron. Los disparadores sólo usan funciones de SQLite: así
// funcionan en cualquier conexión, también en la de una versión anterior del servidor.
//
// Sólo aditiva: una tabla, sus índices, los disparadores y un índice de intereses por contacto (los filtros de etapa,
// responsable y curso preguntan por los intereses de cada contacto). El relleno es una sola sentencia por tabla.
import { searchKeySql } from '../../../lib/search-key.mjs';

// El siguiente número de cambio: uno más que el mayor (el índice de `rev` lo da sin recorrer la tabla). SQLite
// escribe de uno en uno, así que dos cambios nunca reciben el mismo número.
const NEXT_REV = '(SELECT COALESCE(MAX(rev), 0) + 1 FROM contact_search)';

// Señala un cambio en la fila del contacto `who`, y opcionalmente adelanta su última actividad hasta `at`.
const touch = (who, at) =>
  `UPDATE contact_search SET ${at ? `activity_at = MAX(activity_at, COALESCE(${at}, 0)), ` : ''}rev = ${NEXT_REV} WHERE contact_id = ${who};`;

// El contacto de una conversación: el de su marca que nació del mismo perfil de cliente.
const CONVERSATION_CONTACT =
  '(SELECT id FROM contacts WHERE brand_id = new.brand_id AND source_user_id = new.customer_id)';

export default {
  name: 'contacts/0001-search',
  after: ['identity/0001-phone-key'],
  up(db) {
    db.exec(`
      CREATE TABLE contact_search(
        contact_id TEXT PRIMARY KEY,
        brand_id TEXT NOT NULL,
        name_key TEXT NOT NULL DEFAULT '',
        email_key TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT 0,
        activity_at INTEGER NOT NULL DEFAULT 0,
        rev INTEGER NOT NULL DEFAULT 0
      ) WITHOUT ROWID;
      CREATE INDEX contact_search_name ON contact_search(brand_id, name_key, contact_id);
      CREATE INDEX contact_search_created ON contact_search(brand_id, created_at, contact_id);
      CREATE INDEX contact_search_activity ON contact_search(brand_id, activity_at, contact_id);
      CREATE INDEX contact_search_rev ON contact_search(rev);
      CREATE INDEX opportunities_contact ON opportunities(contact_id, stage);
    `);

    // Relleno: la actividad es la mayor fecha entre el contacto, sus intereses y sus conversaciones. Los máximos se
    // calculan una vez por tabla (agrupados), no una vez por contacto.
    db.exec(`
      INSERT INTO contact_search(contact_id, brand_id, name_key, email_key, created_at, activity_at, rev)
      SELECT c.id, c.brand_id, ${searchKeySql('c.name')}, ${searchKeySql('c.email')}, c.created_at,
        MAX(c.created_at, c.updated_at, COALESCE(o.at, 0), COALESCE(v.at, 0)), 0
      FROM contacts c
      LEFT JOIN (SELECT contact_id, MAX(updated_at) at FROM opportunities GROUP BY contact_id) o ON o.contact_id = c.id
      LEFT JOIN (SELECT brand_id, customer_id, MAX(updated_at) at FROM conversations GROUP BY brand_id, customer_id) v
        ON v.brand_id = c.brand_id AND v.customer_id = c.source_user_id;
    `);

    // El contacto: alta, edición y baja (la fusión borra el que se une). Alta y edición escriben la fila completa:
    // si por cualquier motivo faltara, la vuelven a crear en lugar de fallar, y nunca impiden guardar el contacto.
    const upsert = `
      INSERT INTO contact_search(contact_id, brand_id, name_key, email_key, created_at, activity_at, rev)
      VALUES (new.id, new.brand_id, ${searchKeySql('new.name')}, ${searchKeySql('new.email')}, new.created_at,
        MAX(new.created_at, new.updated_at), ${NEXT_REV})
      ON CONFLICT(contact_id) DO UPDATE SET brand_id = excluded.brand_id, name_key = excluded.name_key,
        email_key = excluded.email_key, activity_at = MAX(activity_at, excluded.activity_at), rev = excluded.rev;`;
    db.exec(`
      CREATE TRIGGER contact_search_insert AFTER INSERT ON contacts BEGIN ${upsert} END;
      CREATE TRIGGER contact_search_update AFTER UPDATE ON contacts BEGIN ${upsert} END;
      CREATE TRIGGER contact_search_delete AFTER DELETE ON contacts BEGIN
        DELETE FROM contact_search WHERE contact_id = old.id;
      END;
      CREATE TRIGGER contact_search_tag_add AFTER INSERT ON contact_tag_links BEGIN ${touch('new.contact_id')} END;
      CREATE TRIGGER contact_search_tag_remove AFTER DELETE ON contact_tag_links BEGIN ${touch('old.contact_id')} END;
      CREATE TRIGGER contact_search_consent_add AFTER INSERT ON contact_consent BEGIN ${touch('new.contact_id')} END;
      CREATE TRIGGER contact_search_consent_change AFTER UPDATE ON contact_consent BEGIN ${touch('new.contact_id')} END;
      CREATE TRIGGER contact_search_interest_add AFTER INSERT ON opportunities BEGIN
        ${touch('new.contact_id', 'new.updated_at')}
      END;
      CREATE TRIGGER contact_search_interest_change AFTER UPDATE ON opportunities BEGIN
        ${touch('new.contact_id', 'new.updated_at')}
      END;
      CREATE TRIGGER contact_search_conversation_add AFTER INSERT ON conversations BEGIN
        ${touch(CONVERSATION_CONTACT, 'new.updated_at')}
      END;
      CREATE TRIGGER contact_search_conversation_change AFTER UPDATE OF updated_at ON conversations BEGIN
        ${touch(CONVERSATION_CONTACT, 'new.updated_at')}
      END;
    `);
  },
};
