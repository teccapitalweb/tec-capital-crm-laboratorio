import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';
import {csvLine} from './contacts.mjs';
import {COMPANY_TZ,periodDay} from './finance-schema.mjs';

// Finanzas (Fase 2 · bloque 2.4). El libro de ventas se alimenta de eventos: `pago.confirmado` crea la línea `sale`
// (una por pedido, idempotente) y el reembolso registrado por administración crea la línea `refund`. Desde el libro salen
// ingresos por día/semana/mes, por consultora (marca), curso, vendedor y método; las comisiones se devengan al entrar la
// línea con la regla vigente (por marca o la de la empresa) y quedan auditables con la regla aplicada; se liquidan en
// pagos. La función «contadora» la concede administración a personas del equipo: lectura de todas las marcas y,
// opcionalmente, marcar comisiones pagadas. Las cifras son del laboratorio; no hay facturación, nómina ni banco.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().slice(0,max):'';
export const ROLES={consultora:'Consultora (marca)',vendedor:'Vendedor'};
const METHODS={card:'Tarjeta',oxxo:'OXXO',transfer:'Transferencia'};
const money=(cents,currency='MXN')=>new Intl.NumberFormat('es-MX',{style:'currency',currency}).format((cents||0)/100);
const DAY=86400000;
const tzOffset=t=>{const p=new Intl.DateTimeFormat('en-US',{timeZone:COMPANY_TZ,hourCycle:'h23',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit'}).formatToParts(t).reduce((a,x)=>(a[x.type]=x.value,a),{});return Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute,p.second)-t;};
export const dayStart=ymd=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(ymd))return null;const guess=Date.parse(ymd+'T00:00:00Z');if(!Number.isFinite(guess))return null;return guess-tzOffset(guess);};
const weekKey=day=>{const d=new Date(day+'T00:00:00Z'),dow=(d.getUTCDay()+6)%7;d.setUTCDate(d.getUTCDate()-dow);return d.toISOString().slice(0,10);};
export const periodKey=(day,group)=>group==='month'?day.slice(0,7):group==='week'?weekKey(day):day;
// Comisión de una línea con una regla: porcentaje sobre la base (con signo) más cuota fija sólo en ventas.
export const commissionAmount=(baseCents,rule,kind)=>Math.round(baseCents*rule.percent_bp/10000)+(kind==='sale'?rule.fixed_cents:0);

export function createFinance({db,crm,events,body,json,audit,broadcast,now=Date.now}){
  const roleOf=user=>db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  function access(user){
    const u=roleOf(user);if(!u||u.disabled||u.role==='customer')return {allowed:false,canMarkPaid:false,admin:false};
    if(u.role==='admin')return {allowed:true,canMarkPaid:true,admin:true};
    const a=db.prepare('SELECT can_mark_paid FROM finance_access WHERE user_id=?').get(user.id);return {allowed:Boolean(a),canMarkPaid:Boolean(a?.can_mark_paid),admin:false};
  }
  const requireFinance=user=>{const a=access(user);if(!a.allowed)throw fail(403,'Finanzas es para administración y las personas con función de contadora.');return a;};
  const requireAdmin=user=>{if(!access(user).admin)throw fail(403,'Esta acción requiere un administrador.');};
  const requireMarkPaid=user=>{if(!requireFinance(user).canMarkPaid)throw fail(403,'Marcar comisiones pagadas requiere permiso de administración.');};
  const brandName=id=>db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name||id;
  const userName=id=>id?db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name||null:null;
  // Finanzas es una función de empresa: quien la tiene ve todas las marcas (lo concede administración).
  const scope=brand=>{const all=db.prepare('SELECT id FROM brands').all().map(b=>b.id);if(brand&&brand!=='all'){if(!all.includes(brand))throw fail(404,'Marca no disponible.');return [brand];}return all;};
  const ph=ids=>ids.map(()=>'?').join(',')||'NULL';

  // ---- reglas y devengo
  const ruleFor=(brandId,role)=>db.prepare('SELECT * FROM commission_rules WHERE brand_id=? AND role=?').get(brandId,role)||db.prepare('SELECT * FROM commission_rules WHERE brand_id IS NULL AND role=?').get(role)||null;
  function accrue(e){
    let n=0;
    for(const role of Object.keys(ROLES)){
      if(role==='vendedor'&&!e.seller_id)continue;
      const rule=ruleFor(e.brand_id,role);if(!rule)continue;
      const amount=commissionAmount(e.amount_cents,rule,e.kind);if(!amount)continue;
      n+=db.prepare("INSERT OR IGNORE INTO commission_entries(id,ledger_id,brand_id,role,user_id,rule_id,base_cents,percent_bp,fixed_cents,amount_cents,currency,status,payout_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,'accrued',NULL,?)").run(randomUUID(),e.id,e.brand_id,role,role==='vendedor'?e.seller_id:null,rule.id,e.amount_cents,rule.percent_bp,rule.fixed_cents,amount,e.currency,now()).changes;
    }
    return n;
  }
  const entry=id=>db.prepare('SELECT * FROM ledger_entries WHERE id=?').get(id);
  // Línea de venta desde el pago confirmado (suscriptor, fuera de la transacción del pago; idempotente por pedido).
  function recordSale(ev){
    const o=db.prepare('SELECT o.*,op.owner_id FROM orders o JOIN opportunities op ON op.id=o.opportunity_id WHERE o.id=?').get(ev.entity_id);
    if(!o||o.status!=='paid')return null;
    return transaction(db,()=>{
      const at=o.paid_at||ev.created_at,id=randomUUID();
      if(!db.prepare('INSERT OR IGNORE INTO ledger_entries(id,kind,brand_id,order_id,enrollment_id,contact_id,course_id,edition_id,seller_id,amount_cents,currency,method,provider_ref,event_seq,occurred_at,period_day,note,created_by,dedupe_key,created_at) VALUES(?,\'sale\',?,?,?,?,?,?,?,?,?,?,?,?,?,?,\'\',NULL,?,?)').run(id,o.brand_id,o.id,ev.payload.enrollmentId||null,o.contact_id,o.course_id,o.edition_id,o.owner_id||o.created_by||null,o.amount_cents,o.currency,o.method,o.provider_ref,ev.seq,at,periodDay(at),'sale:'+o.id,now()).changes)return null;
      accrue(entry(id));return id;
    });
  }
  function refund(input,user){
    requireAdmin(user);
    const o=db.prepare('SELECT * FROM orders WHERE id=? OR reference=?').get(text(input.orderId,60),text(input.orderId,60).toUpperCase());if(!o||o.status!=='paid')throw fail(404,'Pedido pagado no encontrado.');
    const reason=text(input.reason,500);if(reason.length<5)throw fail(400,'Indica el motivo del reembolso (mínimo 5 caracteres).');
    const amount=Number(input.amountCents);const refunded=-(db.prepare("SELECT COALESCE(sum(amount_cents),0) n FROM ledger_entries WHERE order_id=? AND kind='refund'").get(o.id).n);
    if(!Number.isInteger(amount)||amount<1||amount>o.amount_cents-refunded)throw fail(400,'El importe a reembolsar debe ser mayor que cero y no superar lo cobrado pendiente de reembolso ('+money(o.amount_cents-refunded,o.currency)+').');
    const sale=db.prepare("SELECT * FROM ledger_entries WHERE order_id=? AND kind='sale'").get(o.id);
    const t=now(),id=randomUUID();
    transaction(db,()=>{
      db.prepare('INSERT INTO ledger_entries(id,kind,brand_id,order_id,enrollment_id,contact_id,course_id,edition_id,seller_id,amount_cents,currency,method,provider_ref,event_seq,occurred_at,period_day,note,created_by,dedupe_key,created_at) VALUES(?,\'refund\',?,?,?,?,?,?,?,?,?,?,NULL,NULL,?,?,?,?,?,?)').run(id,o.brand_id,o.id,sale?.enrollment_id||null,o.contact_id,o.course_id,o.edition_id,sale?.seller_id||null,-amount,o.currency,o.method,t,periodDay(t),reason,user.id,'refund:'+o.id+':'+t,t);
      accrue(entry(id));
      events.publish({type:'reembolso.registrado',brandId:o.brand_id,entityKind:'order',entityId:o.id,payload:{reference:o.reference,amountCents:amount,currency:o.currency,reason,ledgerId:id},actorId:user.id,source:'finance',dedupeKey:'reembolso.registrado:'+id});
    });
    audit(user,'finance.refund',o.id);broadcast('crm',null,{brandId:o.brand_id});return ledgerView(entry(id));
  }
  // Devenga las comisiones que faltan (líneas sin comisión para un rol con regla): tras fijar o cambiar una regla.
  function recompute(user){
    requireAdmin(user);let n=0;
    transaction(db,()=>{for(const e of db.prepare('SELECT * FROM ledger_entries ORDER BY seq').all())n+=accrue(e);});
    audit(user,'finance.recompute',String(n));return n;
  }
  function setRule(input,user){
    requireAdmin(user);const role=String(input.role||'');if(!ROLES[role])throw fail(400,'Rol de comisión no válido.');
    const brandId=text(input.brandId,60)||null;if(brandId&&!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');
    const bp=Number(input.percentBp),fixed=input.fixedCents===undefined?0:Number(input.fixedCents);
    if(!Number.isInteger(bp)||bp<0||bp>10000)throw fail(400,'El porcentaje va de 0 a 100 (en centésimas: 0 a 10000).');if(!Number.isInteger(fixed)||fixed<0||fixed>10000000)throw fail(400,'La cuota fija no es válida.');
    const current=brandId?db.prepare('SELECT * FROM commission_rules WHERE brand_id=? AND role=?').get(brandId,role):db.prepare('SELECT * FROM commission_rules WHERE brand_id IS NULL AND role=?').get(role);
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==(current?.revision||0))throw fail(409,'La regla cambió. Recárgala.');
    const t=now();
    if(current)db.prepare('UPDATE commission_rules SET percent_bp=?,fixed_cents=?,revision=revision+1,updated_by=?,updated_at=? WHERE id=?').run(bp,fixed,user.id,t,current.id);
    else db.prepare('INSERT INTO commission_rules(id,brand_id,role,percent_bp,fixed_cents,revision,updated_by,created_at,updated_at) VALUES(?,?,?,?,?,1,?,?,?)').run(randomUUID(),brandId,role,bp,fixed,user.id,t,t);
    audit(user,'finance.rule',(brandId||'empresa')+':'+role);return rules();
  }
  const rules=()=>db.prepare('SELECT r.*,b.name brand_name,u.name updated_by_name FROM commission_rules r LEFT JOIN brands b ON b.id=r.brand_id LEFT JOIN users u ON u.id=r.updated_by ORDER BY r.brand_id IS NOT NULL,b.name,r.role').all();

  // ---- consultas
  function period(p){
    let from,to;
    if(p.get('from')||p.get('to')){from=dayStart(p.get('from')||'');to=dayStart(p.get('to')||'');if(from===null||to===null||to<from)throw fail(400,'Indica un periodo válido (AAAA-MM-DD) con fin posterior al inicio.');to+=DAY;if(to-from>400*DAY)throw fail(400,'El periodo no puede superar 400 días.');}
    else{const days=Number(p.get('days')||30);if(!Number.isInteger(days)||days<1||days>400)throw fail(400,'Elige un periodo de 1 a 400 días.');to=now();from=to-days*DAY;}
    const group=['day','week','month'].includes(p.get('group'))?p.get('group'):'day';return {from,to,group};
  }
  const ledgerView=e=>({...e,brand_name:brandName(e.brand_id),course_title:e.course_id?db.prepare('SELECT title FROM courses WHERE id=?').get(e.course_id)?.title||null:null,edition_name:e.edition_id?db.prepare('SELECT name FROM editions WHERE id=?').get(e.edition_id)?.name||null:null,contact_name:e.contact_id?db.prepare('SELECT name FROM contacts WHERE id=?').get(e.contact_id)?.name||null:null,seller_name:userName(e.seller_id),reference:e.order_id?db.prepare('SELECT reference FROM orders WHERE id=?').get(e.order_id)?.reference||null:null,methodLabel:e.method?METHODS[e.method]||e.method:null,amountLabel:money(e.amount_cents,e.currency),kindLabel:e.kind==='sale'?'Venta':'Reembolso',commissions:db.prepare('SELECT role,user_id,amount_cents,status,percent_bp,fixed_cents FROM commission_entries WHERE ledger_id=? ORDER BY role').all(e.id).map(c=>({...c,user_name:userName(c.user_id),amountLabel:money(c.amount_cents,e.currency)}))});
  function entriesIn(ids,from,to,extra='',args=[]){return db.prepare(`SELECT * FROM ledger_entries WHERE brand_id IN (${ph(ids)}) AND occurred_at>=? AND occurred_at<? ${extra} ORDER BY occurred_at DESC,seq DESC`).all(...ids,from,to,...args);}
  function summary(user,params){
    requireFinance(user);const {from,to,group}=period(params),ids=scope(params.get('brand')),rows=entriesIn(ids,from,to);
    const sales=rows.filter(r=>r.kind==='sale'),refunds=rows.filter(r=>r.kind==='refund');
    const sum=list=>list.reduce((n,r)=>n+r.amount_cents,0),currency=rows[0]?.currency||'MXN';
    const bucket=(keyOf,labelOf=k=>k)=>{const m=new Map();for(const r of rows){const k=keyOf(r);if(k===undefined)continue;const b=m.get(k)||{key:k,label:labelOf(k,r),sales:0,salesCents:0,refunds:0,refundsCents:0,netCents:0};if(r.kind==='sale'){b.sales++;b.salesCents+=r.amount_cents;}else{b.refunds++;b.refundsCents+=-r.amount_cents;}b.netCents+=r.amount_cents;m.set(k,b);}return [...m.values()].map(b=>({...b,salesLabel:money(b.salesCents,currency),refundsLabel:money(b.refundsCents,currency),netLabel:money(b.netCents,currency)}));};
    const byPeriod=bucket(r=>periodKey(r.period_day,group)).sort((a,b)=>a.key<b.key?-1:1);
    const byBrand=bucket(r=>r.brand_id,k=>brandName(k)).sort((a,b)=>b.netCents-a.netCents);
    const courseTitle=id=>db.prepare('SELECT title FROM courses WHERE id=?').get(id)?.title||id;
    const byCourse=bucket(r=>r.course_id||'—',(k,r)=>courseTitle(k)+' · '+brandName(r.brand_id)).sort((a,b)=>b.netCents-a.netCents);
    const bySeller=bucket(r=>r.seller_id||'none',k=>k==='none'?'Sin vendedor (motor de respuestas)':userName(k)||k).sort((a,b)=>b.netCents-a.netCents);
    const byMethod=bucket(r=>r.method||'—',k=>METHODS[k]||k);
    const commissionRows=db.prepare(`SELECT c.role,c.status,sum(c.amount_cents) cents,count(*) n FROM commission_entries c JOIN ledger_entries l ON l.id=c.ledger_id WHERE l.brand_id IN (${ph(ids)}) AND l.occurred_at>=? AND l.occurred_at<? GROUP BY c.role,c.status`).all(...ids,from,to);
    const commissions=Object.fromEntries(Object.keys(ROLES).map(role=>{const of=s=>commissionRows.find(r=>r.role===role&&r.status===s)?.cents||0;return [role,{accruedCents:of('accrued'),paidCents:of('paid'),accruedLabel:money(of('accrued'),currency),paidLabel:money(of('paid'),currency)}];}));
    const pendingAll=db.prepare(`SELECT role,sum(amount_cents) cents FROM commission_entries WHERE status='accrued' AND brand_id IN (${ph(ids)}) GROUP BY role`).all(...ids);
    // Conciliación: cada pedido pagado del periodo debe tener exactamente una línea de venta con el mismo importe.
    const paidOrders=db.prepare(`SELECT o.id,o.reference,o.amount_cents,o.currency,o.paid_at,(SELECT count(*) FROM ledger_entries l WHERE l.order_id=o.id AND l.kind='sale') lines,(SELECT sum(amount_cents) FROM ledger_entries l WHERE l.order_id=o.id AND l.kind='sale') booked FROM orders o WHERE o.status='paid' AND o.brand_id IN (${ph(ids)}) AND o.paid_at>=? AND o.paid_at<?`).all(...ids,from,to);
    const orphanLines=db.prepare(`SELECT l.id,l.order_id,l.amount_cents FROM ledger_entries l LEFT JOIN orders o ON o.id=l.order_id WHERE l.kind='sale' AND l.brand_id IN (${ph(ids)}) AND l.occurred_at>=? AND l.occurred_at<? AND (o.id IS NULL OR o.status!='paid')`).all(...ids,from,to);
    const mismatches=[...paidOrders.filter(o=>o.lines!==1||o.booked!==o.amount_cents).map(o=>({kind:o.lines===0?'Pedido pagado sin línea en el libro':o.lines>1?'Pedido con más de una línea de venta':'Importe distinto entre pedido y libro',reference:o.reference,orderId:o.id,amountCents:o.amount_cents,bookedCents:o.booked||0})),...orphanLines.map(l=>({kind:'Línea de venta sin pedido pagado',orderId:l.order_id,amountCents:l.amount_cents,bookedCents:l.amount_cents}))];
    const reconciliation={paidOrders:paidOrders.length,paidOrdersCents:paidOrders.reduce((n,o)=>n+o.amount_cents,0),ledgerSales:sales.length,ledgerSalesCents:sum(sales),mismatches,ok:mismatches.length===0&&paidOrders.length===sales.length};
    return {period:{from,to,group,fromDay:periodDay(from),toDay:periodDay(to-1),timezone:COMPANY_TZ},scope:{brand:params.get('brand')&&params.get('brand')!=='all'?params.get('brand'):null,brands:ids.map(id=>({id,name:brandName(id)}))},currency,
      totals:{sales:sales.length,salesCents:sum(sales),salesLabel:money(sum(sales),currency),refunds:refunds.length,refundsCents:-sum(refunds),refundsLabel:money(-sum(refunds),currency),netCents:sum(rows),netLabel:money(sum(rows),currency),avgTicketCents:sales.length?Math.round(sum(sales)/sales.length):0,avgTicketLabel:money(sales.length?Math.round(sum(sales)/sales.length):0,currency)},
      byPeriod,byBrand,byCourse,bySeller,byMethod,commissions,pendingCommissions:Object.fromEntries(Object.keys(ROLES).map(r=>[r,pendingAll.find(x=>x.role===r)?.cents||0])),reconciliation,rules:rules(),access:access(user),roles:ROLES,
      notes:['Cifras del laboratorio: los pagos son simulados y no hay cobros reales.','El libro se alimenta de eventos (pago confirmado, reembolso registrado); las tablas de pedidos siguen siendo el detalle.','Las comisiones se devengan con la regla vigente al entrar la línea y quedan registradas con esa regla; cambiar la regla no modifica las ya devengadas.','Días en la zona '+COMPANY_TZ+'.']};
  }
  function ledger(user,params){
    requireFinance(user);const {from,to}=period(params),ids=scope(params.get('brand')),kind=params.get('kind'),q=text(params.get('q')||'',80);
    const extra=(kind==='sale'||kind==='refund'?" AND kind='"+kind+"'":'')+(q?' AND (order_id IN (SELECT id FROM orders WHERE reference LIKE ?) OR contact_id IN (SELECT id FROM contacts WHERE name LIKE ?) OR course_id IN (SELECT id FROM courses WHERE title LIKE ?))':'');
    const like='%'+q+'%';return entriesIn(ids,from,to,extra,q?[like,like,like]:[]).slice(0,500).map(ledgerView);
  }
  function commissions(user,params){
    requireFinance(user);const ids=scope(params.get('brand')),status=['accrued','paid','void'].includes(params.get('status'))?params.get('status'):'accrued',role=ROLES[params.get('role')]?params.get('role'):null;
    const rows=db.prepare(`SELECT c.*,l.kind,l.occurred_at,l.order_id,l.course_id FROM commission_entries c JOIN ledger_entries l ON l.id=c.ledger_id WHERE c.brand_id IN (${ph(ids)}) AND c.status=?${role?' AND c.role=?':''} ORDER BY l.occurred_at DESC LIMIT 1000`).all(...ids,status,...(role?[role]:[]));
    const groups=new Map();
    for(const r of rows){const key=r.role+':'+r.brand_id+':'+(r.user_id||'');const g=groups.get(key)||{key,role:r.role,roleLabel:ROLES[r.role],brand_id:r.brand_id,brand_name:brandName(r.brand_id),user_id:r.user_id,user_name:userName(r.user_id),currency:r.currency,totalCents:0,entries:0,items:[]};g.totalCents+=r.amount_cents;g.entries++;g.items.push({id:r.id,kind:r.kind,occurred_at:r.occurred_at,amount_cents:r.amount_cents,amountLabel:money(r.amount_cents,r.currency),base_cents:r.base_cents,percent_bp:r.percent_bp,fixed_cents:r.fixed_cents,reference:r.order_id?db.prepare('SELECT reference FROM orders WHERE id=?').get(r.order_id)?.reference:null,course_title:r.course_id?db.prepare('SELECT title FROM courses WHERE id=?').get(r.course_id)?.title:null,payout_id:r.payout_id});groups.set(key,g);}
    return {status,groups:[...groups.values()].map(g=>({...g,totalLabel:money(g.totalCents,g.currency)})).sort((a,b)=>b.totalCents-a.totalCents),payouts:db.prepare(`SELECT p.*,b.name brand_name,u.name user_name,pb.name paid_by_name FROM commission_payouts p LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN users u ON u.id=p.user_id LEFT JOIN users pb ON pb.id=p.paid_by WHERE p.brand_id IN (${ph(ids)}) ORDER BY p.paid_at DESC LIMIT 50`).all(...ids).map(p=>({...p,totalLabel:money(p.total_cents,p.currency),roleLabel:ROLES[p.role]}))};
  }
  // Liquidar: todas las comisiones devengadas de un beneficiario (rol + marca [+ vendedor]) pasan a pagadas en un pago.
  function payout(input,user){
    requireMarkPaid(user);const role=String(input.role||'');if(!ROLES[role])throw fail(400,'Rol no válido.');
    const brandId=text(input.brandId,60);if(!db.prepare('SELECT 1 FROM brands WHERE id=?').get(brandId))throw fail(404,'Marca no encontrada.');
    const userId=role==='vendedor'?text(input.userId,60):null;if(role==='vendedor'&&!userId)throw fail(400,'Indica la persona vendedora.');
    const note=text(input.note,300),t=now(),id=randomUUID();
    const out=transaction(db,()=>{
      const rows=db.prepare(`SELECT * FROM commission_entries WHERE status='accrued' AND role=? AND brand_id=? AND ${userId?'user_id=?':'user_id IS NULL'}`).all(role,brandId,...(userId?[userId]:[]));
      const total=rows.reduce((n,r)=>n+r.amount_cents,0);if(!rows.length||total<=0)throw fail(409,rows.length?'El saldo devengado no es positivo; no hay nada que pagar.':'No hay comisiones devengadas para ese beneficiario.');
      db.prepare('INSERT INTO commission_payouts(id,role,brand_id,user_id,total_cents,currency,entries,note,paid_by,paid_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,role,brandId,userId,total,rows[0].currency,rows.length,note,user.id,t,t);
      const mark=db.prepare("UPDATE commission_entries SET status='paid',payout_id=? WHERE id=? AND status='accrued'");let n=0;for(const r of rows)n+=mark.run(id,r.id).changes;if(n!==rows.length)throw fail(409,'Las comisiones cambiaron mientras se liquidaban. Recarga.');
      events.publish({type:'comision.pagada',brandId,entityKind:'payout',entityId:id,payload:{role,userId,totalCents:total,currency:rows[0].currency,entries:rows.length,note},actorId:user.id,source:'finance'});
      return {id,role,brandId,userId,totalCents:total,totalLabel:money(total,rows[0].currency),entries:rows.length,paidAt:t};
    });
    audit(user,'finance.payout',id);broadcast('crm',null,{brandId});return out;
  }
  // ---- acceso de contadora
  const accessList=user=>{requireAdmin(user);return db.prepare("SELECT u.id,u.name,u.username,u.role,COALESCE(u.disabled,0) disabled,f.can_mark_paid,f.created_at granted_at,g.name granted_by_name FROM users u LEFT JOIN finance_access f ON f.user_id=u.id LEFT JOIN users g ON g.id=f.granted_by WHERE u.role IN ('agent','admin') ORDER BY u.role,u.name").all().map(u=>({...u,finance:u.role==='admin'||u.granted_at!==null,can_mark_paid:u.role==='admin'?1:u.can_mark_paid||0}));};
  function setAccess(input,user){
    requireAdmin(user);const id=text(input.userId,60),u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(id);if(!u||u.role==='customer')throw fail(404,'Persona del equipo no encontrada.');if(u.role==='admin')throw fail(409,'Administración ya tiene acceso completo a Finanzas.');
    if(input.enabled)db.prepare('INSERT INTO finance_access(user_id,can_mark_paid,granted_by,created_at) VALUES(?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET can_mark_paid=excluded.can_mark_paid,granted_by=excluded.granted_by,created_at=excluded.created_at').run(id,input.canMarkPaid?1:0,user.id,now());
    else db.prepare('DELETE FROM finance_access WHERE user_id=?').run(id);
    audit(user,'finance.access',id);return accessList(user);
  }
  // ---- CSV
  const ledgerCsv=rows=>['﻿'+csvLine(['fecha','dia','tipo','marca','curso','edicion','cliente','pedido','vendedor','metodo','importe','moneda','comision_consultora','comision_vendedor','nota']),...rows.map(e=>{const c=r=>e.commissions.find(x=>x.role===r)?.amount_cents??'';return csvLine([new Date(e.occurred_at).toISOString(),e.period_day,e.kindLabel,e.brand_name,e.course_title,e.edition_name,e.contact_name,e.reference,e.seller_name,e.methodLabel,(e.amount_cents/100).toFixed(2),e.currency,c('consultora')===''?'':(c('consultora')/100).toFixed(2),c('vendedor')===''?'':(c('vendedor')/100).toFixed(2),e.note]);})].join('\r\n');
  const commissionsCsv=data=>['﻿'+csvLine(['rol','marca','vendedor','estado','fecha_venta','pedido','curso','base','porcentaje','cuota_fija','comision','moneda','pago']),...data.groups.flatMap(g=>g.items.map(i=>csvLine([g.roleLabel,g.brand_name,g.user_name||'',data.status,new Date(i.occurred_at).toISOString(),i.reference,i.course_title,(i.base_cents/100).toFixed(2),(i.percent_bp/100).toFixed(2)+'%',(i.fixed_cents/100).toFixed(2),(i.amount_cents/100).toFixed(2),g.currency,i.payout_id||''])))].join('\r\n');
  const sendCsv=(res,user,name,content)=>{audit(user,'finance.export',name);res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+name+'-'+periodDay(now())+'.csv"'});res.end(content);};

  events.subscribe('pago.confirmado','finance.ledger',recordSale);

  async function handle(req,res,path,user){
    if(!path.startsWith('/api/finance'))return false;
    const p=new URL(req.url,'http://localhost').searchParams;
    if(path==='/api/finance/me'&&req.method==='GET'){json(res,200,access(user));return true;}
    if(path==='/api/finance'&&req.method==='GET'){json(res,200,summary(user,p));return true;}
    if(path==='/api/finance/ledger'&&req.method==='GET'){json(res,200,{entries:ledger(user,p)});return true;}
    if(path==='/api/finance/ledger.csv'&&req.method==='GET'){sendCsv(res,user,'libro-ventas',ledgerCsv(ledger(user,p)));return true;}
    if(path==='/api/finance/commissions'&&req.method==='GET'){json(res,200,commissions(user,p));return true;}
    if(path==='/api/finance/commissions.csv'&&req.method==='GET'){sendCsv(res,user,'comisiones',commissionsCsv(commissions(user,p)));return true;}
    if(path==='/api/finance/payouts'&&req.method==='POST'){json(res,201,{payout:payout(await body(req),user)});return true;}
    if(path==='/api/finance/rules'){if(req.method==='GET'){requireFinance(user);json(res,200,{rules:rules(),roles:ROLES});return true;}if(req.method==='PUT'){json(res,200,{rules:setRule(await body(req),user)});return true;}}
    if(path==='/api/finance/commissions/recompute'&&req.method==='POST'){json(res,200,{accrued:recompute(user)});return true;}
    if(path==='/api/finance/refunds'&&req.method==='POST'){json(res,201,{entry:refund(await body(req),user)});return true;}
    if(path==='/api/finance/access'){if(req.method==='GET'){json(res,200,{members:accessList(user)});return true;}if(req.method==='PUT'){json(res,200,{members:setAccess(await body(req),user)});return true;}}
    throw fail(404,'Ruta de finanzas no encontrada.');
  }
  return {handle,access,summary,ledger,commissions,payout,setRule,refund,recompute,recordSale,accrue};
}
