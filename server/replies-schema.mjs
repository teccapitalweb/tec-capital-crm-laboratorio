import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';

// Conocimiento de demostración por marca: respuestas de laboratorio, explícitamente de práctica, para que el motor tenga
// con qué contestar preguntas que no salen del catálogo (certificado, pagos, requisitos, modalidad, grabación).
export const DEMO_KNOWLEDGE=[
  {topic:'certificate',question:'¿Entregan certificado?',variants:['certificado','constancia','diploma','aval','valida el certificado','tiene validez'],answer:'Sí. Al terminar el curso y cumplir la asistencia se emite un certificado IPCI con folio y código QR que cualquiera puede verificar en línea. En este laboratorio el certificado es de práctica.'},
  {topic:'payment',question:'¿Cómo puedo pagar?',variants:['formas de pago','metodos de pago','tarjeta','transferencia','oxxo','spei','meses sin intereses','factura'],answer:'Puedes pagar con tarjeta, transferencia SPEI u OXXO desde el enlace de pago que te compartimos. La inscripción queda activa cuando el pago se confirma. En este laboratorio no se realizan cobros reales.'},
  {topic:'requirements',question:'¿Qué necesito para tomar el curso?',variants:['requisitos','necesito saber algo antes','conocimientos previos','que se necesita','material necesario'],answer:'No se requieren conocimientos previos: el curso parte de lo básico. Sólo necesitas conexión a internet y un dispositivo para conectarte a las sesiones en vivo. El material de apoyo se comparte dentro del grupo del curso.'},
  {topic:'modality',question:'¿El curso es en línea o presencial?',variants:['modalidad','en linea','online','presencial','virtual','por zoom','por meet','donde es'],answer:'Las sesiones son en vivo por Google Meet, con el ponente en tiempo real. Antes de iniciar recibes el enlace y el calendario de sesiones en el grupo del curso.'},
  {topic:'recording',question:'¿Si no puedo asistir, queda grabado?',variants:['grabacion','grabado','no puedo asistir','falto a una clase','ver despues','repeticion'],answer:'Sí. Cada sesión se graba y la grabación se comparte con el grupo al terminar, para que puedas repasarla o verla si no pudiste conectarte.'},
  {topic:'duration',question:'¿Cuánto dura el curso?',variants:['duracion','cuantas horas','cuantas sesiones','cuanto tiempo','cuantas clases'],answer:'La duración y el número de sesiones aparecen en la ficha de cada edición. Si me dices qué edición te interesa, te comparto el calendario completo.'},
];

export function migrateReplies(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=13)return;
  transaction(db,()=>{
    db.exec(`
      CREATE TABLE reply_settings(brand_id TEXT PRIMARY KEY REFERENCES brands(id),mode TEXT NOT NULL DEFAULT 'templates' CHECK(mode IN ('off','suggest','templates','autonomous')),provider_enabled INTEGER NOT NULL DEFAULT 0,max_unknown INTEGER NOT NULL DEFAULT 2,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);
      CREATE TABLE knowledge_entries(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT REFERENCES courses(id),topic TEXT NOT NULL,question TEXT NOT NULL,variants TEXT NOT NULL DEFAULT '[]',answer TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','archived')),revision INTEGER NOT NULL DEFAULT 1,created_by TEXT REFERENCES users(id),approved_by TEXT REFERENCES users(id),approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE INDEX knowledge_brand ON knowledge_entries(brand_id,status);
      CREATE TABLE knowledge_versions(entry_id TEXT NOT NULL REFERENCES knowledge_entries(id),revision INTEGER NOT NULL,snapshot TEXT NOT NULL,actor_id TEXT REFERENCES users(id),created_at INTEGER NOT NULL,PRIMARY KEY(entry_id,revision));
      CREATE TABLE reply_log(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversations(id),brand_id TEXT NOT NULL REFERENCES brands(id),trigger_message_id TEXT REFERENCES messages(id),reply_message_id TEXT REFERENCES messages(id),intent TEXT NOT NULL,confidence REAL NOT NULL DEFAULT 0,mode TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('replied','suggested','escalated','skipped')),reply_text TEXT NOT NULL DEFAULT '',sources TEXT NOT NULL DEFAULT '[]',model TEXT,reason TEXT NOT NULL DEFAULT '',consumed_at INTEGER,created_at INTEGER NOT NULL);
      CREATE INDEX reply_log_conversation ON reply_log(conversation_id,created_at);
      PRAGMA user_version=13;
    `);
    for(const b of db.prepare('SELECT id FROM brands').all())seedBrandKnowledge(db,b.id);
  });
}

export function seedBrandKnowledge(db,brandId,now=Date.now()){
  if(db.prepare('SELECT 1 FROM knowledge_entries WHERE brand_id=? LIMIT 1').get(brandId))return 0;
  const insert=db.prepare('INSERT INTO knowledge_entries(id,brand_id,course_id,topic,question,variants,answer,status,revision,approved_at,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,\'approved\',1,?,?,?)');
  const version=db.prepare('INSERT INTO knowledge_versions(entry_id,revision,snapshot,actor_id,created_at) VALUES(?,1,?,NULL,?)');
  for(const k of DEMO_KNOWLEDGE){const id=randomUUID();insert.run(id,brandId,k.topic,k.question,JSON.stringify(k.variants),k.answer,now,now,now);version.run(id,JSON.stringify({...k,status:'approved',source:'demo'}),now);}
  return DEMO_KNOWLEDGE.length;
}
