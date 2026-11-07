import {transaction} from './database.mjs';

// Esquema v34: cupones de descuento (docs/PLAN_CUPONES.md). Un cupón es un código por marca (porcentaje o monto fijo) que el equipo aplica al cobrar
// desde el chat. No hay tabla de canjes: los usos se cuentan sobre los pedidos (`orders.coupon_id`) que siguen vivos (pendientes, en revisión o pagados),
// así un pedido cancelado o vencido libera el cupo solo. El pedido guarda una copia del código y del descuento: cambiar o archivar el cupón después
// no altera lo ya cobrado. Aditivo: una tabla nueva y tres columnas con valor por omisión en `orders`.
export function migrateCoupons(db){
  if(db.prepare('PRAGMA user_version').get().user_version>=34)return;
  transaction(db,()=>db.exec(`
    CREATE TABLE coupons(id TEXT PRIMARY KEY,brand_id TEXT NOT NULL REFERENCES brands(id),code TEXT NOT NULL,name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('percent','amount')),value INTEGER NOT NULL CHECK(value>0),
      course_id TEXT REFERENCES courses(id),edition_id TEXT REFERENCES editions(id),starts_at INTEGER,ends_at INTEGER,
      max_uses INTEGER CHECK(max_uses IS NULL OR max_uses>0),per_contact INTEGER NOT NULL DEFAULT 1 CHECK(per_contact>0),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),revision INTEGER NOT NULL DEFAULT 1,
      created_by TEXT REFERENCES users(id),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(brand_id,code));
    ALTER TABLE orders ADD COLUMN coupon_id TEXT REFERENCES coupons(id);
    ALTER TABLE orders ADD COLUMN coupon_code TEXT;
    ALTER TABLE orders ADD COLUMN discount_cents INTEGER NOT NULL DEFAULT 0;
    CREATE INDEX orders_coupon ON orders(coupon_id,status);
    PRAGMA user_version=34;
  `));
}
