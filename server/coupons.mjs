import {randomUUID} from 'node:crypto';

// Cupones de descuento (docs/PLAN_CUPONES.md). Administración los crea por marca; el equipo escribe el código al cobrar desde el chat y el pedido
// sale con el descuento aplicado. Se valida al previsualizar y otra vez al crear el pedido (dentro de su transacción), con el mismo código de
// reglas: marca, estado, vigencia, alcance (curso o edición), usos totales y usos por persona. El bot nunca aplica cupones.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const GENERIC_CUSTOMER_MESSAGE='Ese cupón no es válido o no está disponible para este pedido.';
export const LIVE="('pending','review','paid')";
export const LIMITS={maxPercent:90,minAmountCents:100,maxPerContact:10};
export const normalizeCode=v=>typeof v==='string'?v.trim().toUpperCase().replace(/\s+/g,''):'';
const CODE=/^[A-Z0-9][A-Z0-9_-]{2,23}$/;
export const money=(cents,currency='MXN')=>new Intl.NumberFormat('es-MX',{style:'currency',currency}).format(cents/100);

export function createCoupons({db,crm,body,json,audit}){
  const now=()=>Date.now();
  const uses=id=>db.prepare(`SELECT count(*) n,coalesce(sum(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) paid,coalesce(sum(CASE WHEN status='paid' THEN discount_cents ELSE 0 END),0) off FROM orders WHERE coupon_id=? AND status IN ${LIVE}`).get(id);
  const view=r=>{const u=uses(r.id);return {id:r.id,brandId:r.brand_id,code:r.code,name:r.name,kind:r.kind,value:r.value,valueLabel:r.kind==='percent'?r.value+' %':money(r.value),courseId:r.course_id||null,editionId:r.edition_id||null,
    courseTitle:r.course_id?db.prepare('SELECT title FROM courses WHERE id=?').get(r.course_id)?.title||null:null,editionName:r.edition_id?db.prepare('SELECT name FROM editions WHERE id=?').get(r.edition_id)?.name||null:null,
    startsAt:r.starts_at||null,endsAt:r.ends_at||null,maxUses:r.max_uses||null,perContact:r.per_contact,customerEntry:Boolean(r.customer_entry),status:r.status,revision:r.revision,uses:u.n,paidUses:u.paid,discountPaidCents:u.off,
    remaining:r.max_uses?Math.max(0,r.max_uses-u.n):null,state:stateOf(r,u.n),createdAt:r.created_at};};
  // Estado efectivo para mostrar: activo, pausado, archivado, aún no vigente, vencido o agotado.
  function stateOf(r,n=uses(r.id).n){const t=now();if(r.status!=='active')return r.status;if(r.starts_at&&t<r.starts_at)return 'scheduled';if(r.ends_at&&t>r.ends_at)return 'expired';if(r.max_uses&&n>=r.max_uses)return 'exhausted';return 'active';}

  // Reglas de un cupón para esta conversación y este precio base. Devuelve el descuento o lanza 409 con el motivo, dicho para el equipo.
  // `customer: true` = lo escribe el cliente en su pantalla de pago: sólo sirve un cupón que administración permitió para eso.
  function validate({brandId,courseId,editionId,contactId,baseCents,code,customer=false}){
    const c=normalizeCode(code);if(!CODE.test(c))throw fail(409,'Escribe un código de cupón válido (letras, números, guion).');
    const r=db.prepare('SELECT * FROM coupons WHERE brand_id=? AND code=?').get(brandId,c);
    if(!r)throw fail(409,'El cupón «'+c+'» no existe en esta marca.');
    if(customer&&!r.customer_entry)throw fail(409,'El cupón «'+c+'» sólo lo aplica el equipo.');
    if(r.status==='paused')throw fail(409,'El cupón «'+c+'» está pausado.');if(r.status==='archived')throw fail(409,'El cupón «'+c+'» ya no está disponible.');
    const t=now();if(r.starts_at&&t<r.starts_at)throw fail(409,'El cupón «'+c+'» todavía no está vigente.');if(r.ends_at&&t>r.ends_at)throw fail(409,'El cupón «'+c+'» ya venció.');
    if(r.edition_id&&r.edition_id!==editionId)throw fail(409,'El cupón «'+c+'» no aplica a esta edición.');if(r.course_id&&r.course_id!==courseId)throw fail(409,'El cupón «'+c+'» no aplica a este curso.');
    const total=db.prepare(`SELECT count(*) n FROM orders WHERE coupon_id=? AND status IN ${LIVE}`).get(r.id).n;
    if(r.max_uses&&total>=r.max_uses)throw fail(409,'El cupón «'+c+'» ya se agotó.');
    if(db.prepare(`SELECT count(*) n FROM orders WHERE coupon_id=? AND contact_id=? AND status IN ${LIVE}`).get(r.id,contactId).n>=r.per_contact)throw fail(409,'Esta persona ya usó el cupón «'+c+'».');
    const off=r.kind==='percent'?Math.floor(baseCents*r.value/100):r.value;
    if(off<=0)throw fail(409,'El cupón no descuenta nada de este precio.');if(off>=baseCents)throw fail(409,'El descuento del cupón cubre todo el importe; no se puede aplicar.');
    return {coupon:r,discountCents:off,finalCents:baseCents-off};
  }

  function check(user,input,current=null){
    const brandId=current?.brand_id||input.brandId;if(typeof brandId!=='string'||!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(400,'Elige la marca del cupón.');
    crm.requireBrand(user,brandId);
    const code=current?current.code:normalizeCode(input.code);if(!CODE.test(code))throw fail(400,'El código lleva de 3 a 24 letras, números o guiones (por ejemplo VERANO20).');
    const name=text(input.name??current?.name,80);if(name.length<2)throw fail(400,'Ponle un nombre al cupón para reconocerlo.');
    const kind=current?current.kind:input.kind,value=current?current.value:Number(input.value);
    if(!['percent','amount'].includes(kind))throw fail(400,'Elige si es porcentaje o monto fijo.');
    if(!Number.isInteger(value)||value<=0)throw fail(400,'El valor del descuento no es válido.');
    if(kind==='percent'&&value>LIMITS.maxPercent)throw fail(400,'El porcentaje máximo es '+LIMITS.maxPercent+' %.');
    if(kind==='amount'&&value<LIMITS.minAmountCents)throw fail(400,'El descuento mínimo es '+money(LIMITS.minAmountCents)+'.');
    let editionId=input.editionId===undefined?current?.edition_id||null:input.editionId||null,courseId=input.courseId===undefined?current?.course_id||null:input.courseId||null;
    if(editionId){const e=db.prepare('SELECT e.id,e.course_id,k.brand_id FROM editions e JOIN courses k ON k.id=e.course_id WHERE e.id=?').get(editionId);if(!e||e.brand_id!==brandId)throw fail(400,'La edición no es de esta marca.');courseId=e.course_id;}
    else if(courseId&&db.prepare('SELECT brand_id FROM courses WHERE id=?').get(courseId)?.brand_id!==brandId)throw fail(400,'El curso no es de esta marca.');
    const num=(v,cur)=>v===undefined?cur:v===null||v===''?null:Number(v);
    const startsAt=num(input.startsAt,current?.starts_at??null),endsAt=num(input.endsAt,current?.ends_at??null);
    for(const v of [startsAt,endsAt])if(v!==null&&!Number.isSafeInteger(v))throw fail(400,'Fecha no válida.');
    if(startsAt&&endsAt&&endsAt<=startsAt)throw fail(400,'El cupón tiene que terminar después de empezar.');
    const maxUses=num(input.maxUses,current?.max_uses??null);if(maxUses!==null&&(!Number.isInteger(maxUses)||maxUses<=0||maxUses>100000))throw fail(400,'El tope de usos no es válido.');
    const perContact=input.perContact===undefined?current?.per_contact??1:Number(input.perContact);if(!Number.isInteger(perContact)||perContact<1||perContact>LIMITS.maxPerContact)throw fail(400,'Los usos por persona van de 1 a '+LIMITS.maxPerContact+'.');
    const customerEntry=input.customerEntry===undefined?Boolean(current?.customer_entry):Boolean(input.customerEntry);
    return {brandId,code,name,kind,value,courseId,editionId,startsAt,endsAt,maxUses,perContact,customerEntry};
  }
  function create(user,input){
    const f=check(user,input),id=randomUUID(),t=now();
    if(db.prepare('SELECT 1 FROM coupons WHERE brand_id=? AND code=?').get(f.brandId,f.code))throw fail(409,'Ya existe un cupón «'+f.code+'» en esta marca.');
    db.prepare('INSERT INTO coupons(id,brand_id,code,name,kind,value,course_id,edition_id,starts_at,ends_at,max_uses,per_contact,customer_entry,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,f.brandId,f.code,f.name,f.kind,f.value,f.courseId,f.editionId,f.startsAt,f.endsAt,f.maxUses,f.perContact,f.customerEntry?1:0,user.id,t,t);
    return view(db.prepare('SELECT * FROM coupons WHERE id=?').get(id));
  }
  function update(user,id,input){
    const cur=db.prepare('SELECT * FROM coupons WHERE id=?').get(id);if(!cur)throw fail(404,'Cupón no disponible.');crm.requireBrand(user,cur.brand_id);
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==cur.revision)throw fail(409,'Otra persona cambió este cupón. Vuelve a abrirlo.');
    if(cur.status==='archived')throw fail(409,'El cupón está archivado.');
    const used=uses(id).n;
    // el código, el tipo y el valor no cambian: lo ya cobrado y lo ya dicho a los clientes se apoyan en ellos
    for(const k of ['code','kind','value'])if(input[k]!==undefined&&String(input[k]).toUpperCase()!==String(k==='code'?cur.code:k==='kind'?cur.kind:cur.value).toUpperCase())throw fail(409,'El código, el tipo y el valor de un cupón no se cambian: crea uno nuevo y pausa este.');
    const f=check(user,input,cur),status=input.status===undefined?cur.status:input.status;
    if(!['active','paused','archived'].includes(status))throw fail(400,'Estado no válido.');
    if(f.maxUses!==null&&f.maxUses<used)throw fail(409,'Ya hay '+used+' usos; el tope no puede ser menor.');
    const changed=db.prepare('UPDATE coupons SET name=?,course_id=?,edition_id=?,starts_at=?,ends_at=?,max_uses=?,per_contact=?,customer_entry=?,status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(f.name,f.courseId,f.editionId,f.startsAt,f.endsAt,f.maxUses,f.perContact,f.customerEntry?1:0,status,now(),id,cur.revision).changes;
    if(!changed)throw fail(409,'Este cupón cambió mientras lo editabas.');
    return view(db.prepare('SELECT * FROM coupons WHERE id=?').get(id));
  }
  function list(user,brand){
    if(brand&&!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brand))throw fail(404,'Marca no disponible.');
    if(brand)crm.requireBrand(user,brand);
    const rows=brand?db.prepare('SELECT * FROM coupons WHERE brand_id=? ORDER BY created_at DESC').all(brand):db.prepare('SELECT * FROM coupons ORDER BY created_at DESC').all();
    return rows.filter(r=>crm.canBrand(user,r.brand_id)).map(view);
  }
  const requireAdmin=user=>{if(user.role!=='admin')throw fail(403,'Los cupones los administra administración.');};

  async function handle(req,res,path,user){
    if(path==='/api/coupons'){
      if(user.role==='customer')throw fail(403,'Los cupones son para el equipo.');requireAdmin(user);
      if(req.method==='GET'){json(res,200,{coupons:list(user,new URL(req.url,'http://x').searchParams.get('brand')||null)});return true;}
      if(req.method==='POST'){const out=create(user,await body(req));audit(user,'coupon.create',out.id);json(res,201,{coupon:out});return true;}
      throw fail(405,'Método no permitido.');
    }
    const m=path.match(/^\/api\/coupons\/([a-f0-9-]+)$/);if(!m)return false;
    if(user.role==='customer')throw fail(403,'Los cupones son para el equipo.');requireAdmin(user);
    if(req.method==='PATCH'){const out=update(user,m[1],await body(req));audit(user,'coupon.update',m[1]);json(res,200,{coupon:out});return true;}
    throw fail(405,'Método no permitido.');
  }
  // ¿La marca tiene algún cupón que el cliente pueda escribir ahora? (sólo para decidir si se muestra «¿Tienes un cupón?»; no revela cuáles ni cuántos)
  const customerOffered=(brandId,courseId,editionId)=>Boolean(db.prepare("SELECT 1 FROM coupons WHERE brand_id=? AND customer_entry=1 AND status='active' AND (course_id IS NULL OR course_id=?) AND (edition_id IS NULL OR edition_id=?) AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>=?) LIMIT 1").get(brandId,courseId,editionId,now(),now()));
  return {handle,validate,view,list,normalizeCode,customerOffered};
}
