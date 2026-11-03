import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';

// Esquema v20 (Fase 2 · bloque 2.4 Finanzas). Libro de ventas alimentado por eventos: una línea por pago confirmado
// (`sale`) y por reembolso registrado (`refund`), con la referencia al pedido, la inscripción, el curso, la edición y la
// persona vendedora en el momento de la venta. Comisiones a consultoras (la marca) y a vendedores con una regla única
// configurable por marca o por omisión de la empresa; cada comisión guarda la regla aplicada (auditable) y se liquida
// agrupándola en un pago. Acceso de «contadora»: lectura de Finanzas para personas del equipo designadas por administración,
// con permiso opcional para marcar comisiones pagadas. Sin facturación, nómina ni banco.
export const COMPANY_TZ='America/Mexico_City';
const dayKey=new Intl.DateTimeFormat('en-CA',{timeZone:COMPANY_TZ,year:'numeric',month:'2-digit',day:'2-digit'});
export const periodDay=t=>dayKey.format(t);

export function migrateFinance(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=20)return;
  transaction(db,()=>{
    db.exec(`
    CREATE TABLE ledger_entries(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,kind TEXT NOT NULL CHECK(kind IN ('sale','refund')),brand_id TEXT NOT NULL REFERENCES brands(id),order_id TEXT REFERENCES orders(id),enrollment_id TEXT REFERENCES enrollments(id),contact_id TEXT REFERENCES contacts(id),course_id TEXT REFERENCES courses(id),edition_id TEXT REFERENCES editions(id),seller_id TEXT REFERENCES users(id),amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,method TEXT,provider_ref TEXT,event_seq INTEGER,occurred_at INTEGER NOT NULL,period_day TEXT NOT NULL,note TEXT NOT NULL DEFAULT '',created_by TEXT REFERENCES users(id),dedupe_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL);
    CREATE INDEX ledger_brand_time ON ledger_entries(brand_id,occurred_at);
    CREATE INDEX ledger_order ON ledger_entries(order_id);
    CREATE TABLE commission_rules(id TEXT PRIMARY KEY,brand_id TEXT REFERENCES brands(id),role TEXT NOT NULL CHECK(role IN ('consultora','vendedor')),percent_bp INTEGER NOT NULL DEFAULT 0 CHECK(percent_bp>=0 AND percent_bp<=10000),fixed_cents INTEGER NOT NULL DEFAULT 0 CHECK(fixed_cents>=0),revision INTEGER NOT NULL DEFAULT 1,updated_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(brand_id,role));
    CREATE TABLE commission_payouts(id TEXT PRIMARY KEY,role TEXT NOT NULL CHECK(role IN ('consultora','vendedor')),brand_id TEXT REFERENCES brands(id),user_id TEXT REFERENCES users(id),total_cents INTEGER NOT NULL,currency TEXT NOT NULL,entries INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',paid_by TEXT REFERENCES users(id),paid_at INTEGER NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE commission_entries(id TEXT PRIMARY KEY,ledger_id TEXT NOT NULL REFERENCES ledger_entries(id),brand_id TEXT NOT NULL REFERENCES brands(id),role TEXT NOT NULL CHECK(role IN ('consultora','vendedor')),user_id TEXT REFERENCES users(id),rule_id TEXT REFERENCES commission_rules(id),base_cents INTEGER NOT NULL,percent_bp INTEGER NOT NULL,fixed_cents INTEGER NOT NULL,amount_cents INTEGER NOT NULL,currency TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('accrued','paid','void')),payout_id TEXT REFERENCES commission_payouts(id),created_at INTEGER NOT NULL,UNIQUE(ledger_id,role));
    CREATE INDEX commission_status ON commission_entries(status,role,brand_id,user_id);
    CREATE TABLE finance_access(user_id TEXT PRIMARY KEY REFERENCES users(id),can_mark_paid INTEGER NOT NULL DEFAULT 0,granted_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL);
    PRAGMA user_version=20;`);
    // Relleno: cada pago ya confirmado entra una sola vez al libro con la fecha del pago; la persona vendedora es quien
    // tenía la oportunidad (o quien creó el pedido). Sin reglas de comisión todavía, las comisiones se devengan cuando
    // administración fije la regla y pida calcular las pendientes.
    const insert=db.prepare('INSERT OR IGNORE INTO ledger_entries(id,kind,brand_id,order_id,enrollment_id,contact_id,course_id,edition_id,seller_id,amount_cents,currency,method,provider_ref,event_seq,occurred_at,period_day,note,created_by,dedupe_key,created_at) VALUES(?,\'sale\',?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,\'Relleno inicial desde pedidos pagados\',NULL,?,?)');
    const t=Date.now();
    for(const o of db.prepare("SELECT o.*,op.owner_id,(SELECT id FROM enrollments e WHERE e.order_id=o.id) enrollment_id FROM orders o JOIN opportunities op ON op.id=o.opportunity_id WHERE o.status='paid' ORDER BY o.paid_at").all()){
      const at=o.paid_at||o.updated_at||t;
      insert.run(randomUUID(),o.brand_id,o.id,o.enrollment_id||null,o.contact_id,o.course_id,o.edition_id,o.owner_id||o.created_by||null,o.amount_cents,o.currency,o.method,o.provider_ref,at,periodDay(at),'sale:'+o.id,t);
    }
  });
}
