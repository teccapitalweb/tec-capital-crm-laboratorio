import {transaction} from './database.mjs';

// Esquema v40: flujo de bienvenida por marca (docs/PLAN_FLUJO_BIENVENIDA.md).
//   welcome_flows  un flujo por marca: encendido, si el saludo lleva la ficha del curso y los pasos (JSON validado por server/flows.mjs).
//   flow_runs      en qué paso va cada conversación (se borra al terminar o al guardar un flujo nuevo).
export function migrateFlows(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=40)return;
  transaction(db,()=>{
    db.exec("CREATE TABLE welcome_flows(brand_id TEXT PRIMARY KEY REFERENCES brands(id),enabled INTEGER NOT NULL DEFAULT 0,with_flyer INTEGER NOT NULL DEFAULT 1,steps TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),updated_at INTEGER NOT NULL);"
      +"CREATE TABLE flow_runs(conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),step_id TEXT NOT NULL,misses INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL);PRAGMA user_version=40;");
  });
}
