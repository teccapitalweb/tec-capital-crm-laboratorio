import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';

// Esquema v18: banco de evaluación del motor de respuestas. Casos con mensaje de cliente y resultado esperado, y
// ejecuciones guardadas para comparar en el tiempo (tras cambiar conocimiento, nivel por marca o proveedor de IA).
export const DEMO_CASES=[
  {title:'Saludo inicial',input:'Hola, me interesa el curso',intent:'greeting',action:'replied',source:'template',tags:'bienvenida'},
  {title:'Pregunta el precio',input:'¿Cuánto cuesta?',intent:'price',action:'replied',source:'catalogue',include:'$',tags:'catalogo'},
  {title:'Pide el temario',input:'¿Qué temas incluye?',intent:'syllabus',action:'replied',source:'catalogue',tags:'catalogo'},
  {title:'Pregunta la fecha',input:'¿Cuándo empieza?',intent:'schedule',action:'replied',source:'catalogue',tags:'catalogo'},
  {title:'Quiere inscribirse',input:'Quiero inscribirme',intent:'enroll',action:null,source:'catalogue',tags:'venta'},
  {title:'Pide hablar con una persona',input:'Quiero hablar con un asesor',intent:'human',action:'escalated',source:null,tags:'persona'},
  {title:'Queja con reembolso',input:'Quiero un reembolso, pésimo servicio',intent:'refund',action:'escalated',source:null,tags:'persona'},
  {title:'Reporta un pago hecho',input:'Ya pagué, les mando el comprobante',intent:'payment',action:'escalated',source:null,tags:'persona,pago'},
  {title:'Pregunta formas de pago',input:'¿Aceptan tarjeta o transferencia?',intent:'payment',action:'replied',source:'knowledge',tags:'conocimiento,pago'},
  {title:'Certificado',input:'¿Entregan certificado?',intent:'certificate',action:'replied',source:'knowledge',tags:'conocimiento'},
  {title:'Grabación de la clase',input:'¿Se graba la clase si no puedo asistir?',intent:'recording',action:'replied',source:'knowledge',tags:'conocimiento'},
  {title:'Requisitos previos',input:'¿Necesito conocimientos previos?',intent:'requirements',action:'replied',source:'knowledge',tags:'conocimiento'},
  {title:'Modalidad',input:'¿Es en línea o presencial?',intent:'modality',action:'replied',source:'knowledge',tags:'conocimiento'},
  {title:'Duración',input:'¿Cuánto dura el curso?',intent:'duration',action:'replied',source:'knowledge',tags:'conocimiento'},
  {title:'Pide la baja',input:'Ya no quiero recibir mensajes',intent:'opt_out',action:'replied',source:null,exclude:'$',tags:'consentimiento'},
  {title:'Pregunta fuera de guion',input:'¿Dan beca para estudiantes?',intent:'unknown',action:'replied',source:null,include:'asesor',tags:'desconocida'},
  {title:'Agradece',input:'Gracias, perfecto',intent:'thanks',action:'replied',source:null,tags:'cierre'},
];
export function seedBrandEvaluation(db,brandId,now=Date.now()){
  if(db.prepare('SELECT 1 FROM eval_cases WHERE brand_id=? LIMIT 1').get(brandId))return 0;
  const insert=db.prepare('INSERT INTO eval_cases(id,brand_id,course_id,title,input_text,expect_intent,expect_action,expect_source,must_include,must_exclude,tags,status,created_by,revision,created_at,updated_at) VALUES(?,?,NULL,?,?,?,?,?,?,?,?,\'active\',NULL,1,?,?)');
  for(const c of DEMO_CASES)insert.run(randomUUID(),brandId,c.title,c.input,c.intent||null,c.action||null,c.source||null,c.include||null,c.exclude||null,c.tags||'',now,now);
  return DEMO_CASES.length;
}
export function migrateEvaluation(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=18)return;
  transaction(db,()=>{
    db.exec(`
    CREATE TABLE eval_cases(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),course_id TEXT REFERENCES courses(id),title TEXT NOT NULL,input_text TEXT NOT NULL,expect_intent TEXT,expect_action TEXT CHECK(expect_action IS NULL OR expect_action IN ('replied','suggested','escalated','skipped')),expect_source TEXT CHECK(expect_source IS NULL OR expect_source IN ('catalogue','knowledge','template','none')),must_include TEXT,must_exclude TEXT,tags TEXT NOT NULL DEFAULT '',status TEXT NOT NULL CHECK(status IN ('active','archived')),created_by TEXT REFERENCES users(id),revision INTEGER NOT NULL DEFAULT 1,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE INDEX eval_cases_brand ON eval_cases(brand_id,status);
    CREATE TABLE eval_runs(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),mode TEXT NOT NULL,provider TEXT NOT NULL,total INTEGER NOT NULL,passed INTEGER NOT NULL,score REAL NOT NULL,results TEXT NOT NULL,duration_ms INTEGER NOT NULL,created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    CREATE INDEX eval_runs_brand ON eval_runs(brand_id,created_at);
    PRAGMA user_version=18;`);
    for(const b of db.prepare('SELECT id FROM brands').all())seedBrandEvaluation(db,b.id);
  });
}
