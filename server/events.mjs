import {randomUUID} from 'node:crypto';
import {transaction} from './database.mjs';
import {backoff} from './automation.mjs';
import {csvCell} from './contacts.mjs';

// Eventos de dominio (Fase 2 · bloque 2.1). Cada hecho relevante del negocio queda registrado UNA sola vez en
// domain_events (tipo, marca, entidad, carga breve, actor, origen, clave de idempotencia). Los módulos lo publican dentro
// de su propia transacción —si la transacción se revierte, el evento no existe— y los suscriptores en proceso reaccionan
// después, fuera de cualquier transacción, con reintento y espera creciente (misma mecánica que automation_steps). Las
// tablas de detalle de cada módulo siguen siendo la fuente; esto es el índice común. Sin cola externa (Fase 4).
const fail=(status,message)=>Object.assign(new Error(message),{status});
const safeError=e=>String(e?.message||e).replace(/[\x00-\x1f]+/g,' ').slice(0,200);

export const EVENT_TYPES={
  'conversacion.abierta':{title:'Conversación abierta',entity:'conversation',payload:'channel, courseId, editionId, referral'},
  'oportunidad.etapa':{title:'Cambio de etapa comercial',entity:'opportunity',payload:'from, to, reason, source'},
  'pedido.creado':{title:'Pedido creado',entity:'order',payload:'reference, amountCents, currency, source, conversationId'},
  'pedido.cupon_aplicado':{title:'Cupón aplicado a un pedido',entity:'order',payload:'reference, couponCode, discountCents, amountCents, currency, by'},
  'pedido.cancelado':{title:'Pedido cancelado',entity:'order',payload:'reference, reason'},
  'pedido.vencido':{title:'Pedido vencido',entity:'order',payload:'reference'},
  'comprobante.recibido':{title:'Comprobante recibido',entity:'order',payload:'receiptId, reference, filename'},
  'pago.confirmado':{title:'Pago confirmado',entity:'order',payload:'reference, amountCents, currency, method, kind, plan, sessionId, enrollmentId, editionId, courseId, contactId, conversationId'},
  'pago.rechazado':{title:'Pago rechazado',entity:'order',payload:'reference, method, reason, provider'},
  'inscripcion.activada':{title:'Inscripción activada',entity:'enrollment',payload:'orderId, editionId, courseId, contactId'},
  'inscripcion.cancelada':{title:'Inscripción cancelada',entity:'enrollment',payload:'editionId, reason'},
  'mensaje.entregado':{title:'Mensaje entregado',entity:'message',payload:'conversationId, category, providerRef'},
  'mensaje.fallido':{title:'Mensaje fallido',entity:'message',payload:'conversationId, category, reason'},
  'baja.registrada':{title:'Baja de mensajes registrada',entity:'person',payload:'source, note, originBrand'},
  'persona.fusionada':{title:'Personas fusionadas',entity:'person',payload:'mergedId, mergedName, contacts'},
  'certificado.emitido':{title:'Certificado emitido',entity:'certificate',payload:'folio, enrollmentId, personId, courseId, editionId, holder, attendancePct, source'},
  'certificado.revocado':{title:'Certificado revocado',entity:'certificate',payload:'folio, reason, holder'},
  'grabacion.disponible':{title:'Grabación disponible',entity:'resource',payload:'editionId, sessionId, title, url'},
  'apertura.abierta':{title:'Apertura confirmada',entity:'edition',payload:'courseId, enrolled, minStudents, auto'},
  'apertura.en_curso':{title:'Apertura en curso',entity:'edition',payload:'courseId'},
  'apertura.cerrada':{title:'Apertura cerrada',entity:'edition',payload:'courseId, enrolled, sessions'},
  'apertura.cancelada':{title:'Apertura cancelada',entity:'edition',payload:'courseId, reason, enrolled'},
  'sesion.programada':{title:'Sesión programada',entity:'session',payload:'editionId, number, title, startsAt'},
  'sesion.proxima':{title:'Recordatorio de sesión',entity:'session',payload:'editionId, number, title, startsAt, students'},
  'sesion.realizada':{title:'Sesión realizada',entity:'session',payload:'editionId, number, present, absent'},
  'sesion.cancelada':{title:'Sesión cancelada',entity:'session',payload:'editionId, number, reason'},
  'asistencia.registrada':{title:'Asistencia registrada',entity:'session',payload:'editionId, present, absent, late, excused'},
  'reembolso.registrado':{title:'Reembolso registrado',entity:'order',payload:'reference, amountCents, currency, reason, ledgerId'},
  'comision.pagada':{title:'Comisión pagada',entity:'payout',payload:'role, userId, totalCents, currency, entries, note'},
  'pago.condonado':{title:'Pago de sesión condonado',entity:'session',payload:'editionId, enrollmentId, number, amountCents, currency, note'},
  'encuesta.enviada':{title:'Encuesta enviada',entity:'survey',payload:'editionId, sessionId, kind, title, invited, skipped'},
  'encuesta.respondida':{title:'Encuesta respondida',entity:'survey',payload:'editionId, sessionId, title, contentScore, instructorScore, organizationScore, nps, comment'},
  'catalogo.precio_cambiado':{title:'Precio de una edición cambió',entity:'edition',payload:'courseId, name, currency, from, to, sessionFrom, sessionTo, deltaCents, deltaPct, direction'},
  'edicion.cupo_cambiado':{title:'Cupo disponible cambió',entity:'edition',payload:'courseId, name, capacity, from, to, reason'},
  'edicion.cupo_agotado':{title:'Se agotó el cupo',entity:'edition',payload:'courseId, name, capacity, from, reason'},
  'edicion.cupo_liberado':{title:'Se liberó un lugar',entity:'edition',payload:'courseId, name, capacity, available, reason'},
  'edicion.cupo_bajo':{title:'Quedan pocos lugares',entity:'edition',payload:'courseId, name, capacity, available, threshold, reason'},
  'historico.importado':{title:'Históricos importados',entity:'batch',payload:'source, format, filename, counts, repeated, personsCreated'},
};
export const ENTITY_KINDS={conversation:'Conversación',opportunity:'Oportunidad',order:'Pedido',enrollment:'Inscripción',message:'Mensaje',contact:'Contacto',edition:'Apertura',session:'Sesión',payout:'Pago de comisión',person:'Persona',certificate:'Certificado',resource:'Recurso de apertura',survey:'Encuesta',batch:'Importación de históricos'};

export function createEvents({db,crm=null,body,json,audit=()=>{},now=Date.now,log=console,baseDelayMs=5_000,capDelayMs=15*60_000,maxAttempts=5,batch=20}){
  const subscribers=new Map();   // tipo -> [{name,handler}]
  const view=e=>({...e,payload:JSON.parse(e.payload)});
  const get=seq=>db.prepare('SELECT * FROM domain_events WHERE seq=?').get(seq);
  const types=()=>Object.entries(EVENT_TYPES).map(([type,t])=>({type,...t,subscribers:(subscribers.get(type)||[]).map(s=>s.name)}));

  function subscribe(type,name,handler){
    if(!EVENT_TYPES[type])throw fail(400,'Tipo de evento no registrado: '+type);
    if(!subscribers.has(type))subscribers.set(type,[]);
    if(subscribers.get(type).some(s=>s.name===name))throw fail(409,'Suscriptor repetido: '+name);
    subscribers.get(type).push({name,handler});
  }
  // Publica dentro de la transacción del llamador (o en autocommit si no hay). Idempotente por dedupe_key:
  // volver a publicar el mismo hecho devuelve el evento existente sin crear entregas nuevas.
  function publish({type,brandId,entityKind,entityId,payload={},actorId=null,source,dedupeKey=null}){
    if(!EVENT_TYPES[type])throw fail(400,'Tipo de evento no registrado: '+type);
    if(!brandId||!entityId||!source)throw fail(400,'El evento necesita marca, entidad y origen.');
    const key=String(dedupeKey||type+':'+entityId).slice(0,200),text=JSON.stringify(payload||{});
    if(text.length>4000)throw fail(400,'La carga del evento es demasiado grande.');
    const existing=db.prepare('SELECT seq,id FROM domain_events WHERE dedupe_key=?').get(key);
    if(existing)return {seq:existing.seq,id:existing.id,duplicate:true};
    const t=now(),id=randomUUID();
    const seq=Number(db.prepare('INSERT INTO domain_events(id,type,brand_id,entity_kind,entity_id,payload,actor_id,source,dedupe_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,type,brandId,entityKind||EVENT_TYPES[type].entity,String(entityId),text,actorId,String(source).slice(0,60),key,t).lastInsertRowid);
    for(const s of subscribers.get(type)||[])db.prepare("INSERT INTO domain_deliveries(event_seq,subscriber,state,attempts,next_attempt_at,updated_at) VALUES(?,?,'pending',0,?,?)").run(seq,s.name,t,t);
    return {seq,id,duplicate:false};
  }
  // Entrega a suscriptores fuera de transacción: cada manejador abre la suya si la necesita. Un error con status 4xx o
  // permanent=true no se reintenta; cualquier otro espera con retroceso exponencial hasta maxAttempts.
  let running=false;
  async function tick(){
    if(running)return 0;running=true;
    try{
      const due=db.prepare("SELECT d.*,e.type FROM domain_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE d.state='pending' AND d.next_attempt_at<=? ORDER BY d.next_attempt_at,d.event_seq LIMIT ?").all(now(),batch);
      let delivered=0;
      for(const d of due){
        const handler=(subscribers.get(d.type)||[]).find(s=>s.name===d.subscriber)?.handler;
        const attempt=d.attempts+1,t0=now();
        if(!handler){db.prepare("UPDATE domain_deliveries SET state='failed',attempts=?,error='Suscriptor no registrado en este proceso',updated_at=? WHERE event_seq=? AND subscriber=?").run(attempt,t0,d.event_seq,d.subscriber);continue;}
        try{await handler(view(get(d.event_seq)));db.prepare("UPDATE domain_deliveries SET state='done',attempts=?,error=NULL,updated_at=? WHERE event_seq=? AND subscriber=?").run(attempt,now(),d.event_seq,d.subscriber);delivered++;}
        catch(e){
          const permanent=e?.permanent===true||(e?.status>=400&&e?.status<500),message=safeError(e),t=now();
          if(permanent||attempt>=maxAttempts)db.prepare("UPDATE domain_deliveries SET state='failed',attempts=?,error=?,updated_at=? WHERE event_seq=? AND subscriber=?").run(attempt,message,t,d.event_seq,d.subscriber);
          else db.prepare("UPDATE domain_deliveries SET attempts=?,error=?,next_attempt_at=?,updated_at=? WHERE event_seq=? AND subscriber=?").run(attempt,message,t+backoff(attempt,baseDelayMs,capDelayMs),t,d.event_seq,d.subscriber);
          log.error('Event delivery failed:',d.type,d.subscriber,message.slice(0,80));
        }
      }
      return delivered;
    }finally{running=false;}
  }
  function retry(seq,subscriber,actor){
    return transaction(db,()=>{
      const d=db.prepare('SELECT * FROM domain_deliveries WHERE event_seq=? AND subscriber=?').get(seq,subscriber);if(!d)throw fail(404,'Entrega no encontrada.');
      if(d.state!=='failed')throw fail(409,'Sólo se reintenta una entrega fallida.');
      const t=now();db.prepare("UPDATE domain_deliveries SET state='pending',attempts=0,error=NULL,next_attempt_at=?,updated_at=? WHERE event_seq=? AND subscriber=?").run(t,t,seq,subscriber);
      audit(actor,'event.retry',String(seq));return true;
    });
  }
  // Reproducción: crea entregas pendientes para un suscriptor en todos los eventos que aún no las tienen (p. ej. el
  // núcleo compartido conectado después de meses de historial). Idempotente: no toca entregas existentes.
  function replay(subscriber,{fromSeq=1,actor=null}={}){
    const name=String(subscriber||'');const types=[...subscribers.entries()].filter(([,list])=>list.some(s=>s.name===name)).map(([type])=>type);
    if(!types.length)throw fail(404,'Suscriptor no registrado.');const ph=types.map(()=>'?').join(',');
    return transaction(db,()=>{
      const t=now(),n=db.prepare(`INSERT OR IGNORE INTO domain_deliveries(event_seq,subscriber,state,attempts,next_attempt_at,updated_at) SELECT e.seq,?,'pending',0,?,? FROM domain_events e WHERE e.seq>=? AND e.type IN (${ph}) AND NOT EXISTS (SELECT 1 FROM domain_deliveries d WHERE d.event_seq=e.seq AND d.subscriber=?)`).run(name,t,t,Math.max(1,Number(fromSeq)||1),...types,name).changes;
      if(actor)audit(actor,'event.replay',name+':'+n);return n;
    });
  }
  // Reintento masivo de las entregas fallidas de un suscriptor.
  function retryFailed(subscriber,actor=null){
    const t=now(),n=db.prepare("UPDATE domain_deliveries SET state='pending',attempts=0,error=NULL,next_attempt_at=?,updated_at=? WHERE subscriber=? AND state='failed'").run(t,t,String(subscriber||'')).changes;
    if(actor)audit(actor,'event.retry-failed',String(subscriber)+':'+n);return n;
  }
  function subscriberStats(subscriber){
    const name=String(subscriber||''),r=db.prepare("SELECT sum(state='pending') pending,sum(state='done') done,sum(state='failed') failed,max(updated_at) last FROM domain_deliveries WHERE subscriber=?").get(name);
    return {pending:r.pending||0,done:r.done||0,failed:r.failed||0,last:r.last||null,lastError:db.prepare("SELECT error FROM domain_deliveries WHERE subscriber=? AND error IS NOT NULL ORDER BY updated_at DESC LIMIT 1").get(name)?.error||null,events:db.prepare('SELECT count(*) n FROM domain_events').get().n,missing:db.prepare('SELECT count(*) n FROM domain_events e WHERE NOT EXISTS (SELECT 1 FROM domain_deliveries d WHERE d.event_seq=e.seq AND d.subscriber=?)').get(name).n};
  }
  const deliveriesOf=seq=>db.prepare('SELECT subscriber,state,attempts,error,next_attempt_at,updated_at FROM domain_deliveries WHERE event_seq=? ORDER BY subscriber').all(seq);

  // Consulta con alcance por marca. Devuelve los más recientes primero; `before` pagina por seq.
  function list(brandIds,{type=null,entityKind=null,entityId=null,q='',before=null,limit=200}={}){
    if(!brandIds.length)return [];
    const where=[`e.brand_id IN (${brandIds.map(()=>'?').join(',')})`],args=[...brandIds];
    if(type&&EVENT_TYPES[type]){where.push('e.type=?');args.push(type);}
    if(entityKind&&ENTITY_KINDS[entityKind]){where.push('e.entity_kind=?');args.push(entityKind);}
    if(entityId){where.push('(e.entity_id=? OR e.payload LIKE ?)');args.push(String(entityId),'%'+String(entityId).slice(0,80)+'%');}
    if(q){where.push('(e.type LIKE ? OR e.payload LIKE ? OR e.entity_id LIKE ?)');const like='%'+String(q).slice(0,80)+'%';args.push(like,like,like);}
    if(before&&Number.isFinite(Number(before))){where.push('e.seq<?');args.push(Number(before));}
    const n=Math.min(500,Math.max(1,Number(limit)||200));
    return db.prepare(`SELECT e.*,u.name actor_name,b.name brand_name,(SELECT count(*) FROM domain_deliveries d WHERE d.event_seq=e.seq AND d.state='pending') pending,(SELECT count(*) FROM domain_deliveries d WHERE d.event_seq=e.seq AND d.state='failed') failed,(SELECT count(*) FROM domain_deliveries d WHERE d.event_seq=e.seq) subscribers FROM domain_events e LEFT JOIN users u ON u.id=e.actor_id JOIN brands b ON b.id=e.brand_id WHERE ${where.join(' AND ')} ORDER BY e.seq DESC LIMIT ?`).all(...args,n).map(view);
  }
  function stats(brandIds){
    if(!brandIds.length)return {total:0,last24h:0,failed:0,pending:0,byType:[]};
    const ph=brandIds.map(()=>'?').join(','),day=now()-86400000;
    return {total:db.prepare(`SELECT count(*) n FROM domain_events WHERE brand_id IN (${ph})`).get(...brandIds).n,last24h:db.prepare(`SELECT count(*) n FROM domain_events WHERE brand_id IN (${ph}) AND created_at>=?`).get(...brandIds,day).n,
      failed:db.prepare(`SELECT count(*) n FROM domain_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE d.state='failed' AND e.brand_id IN (${ph})`).get(...brandIds).n,pending:db.prepare(`SELECT count(*) n FROM domain_deliveries d JOIN domain_events e ON e.seq=d.event_seq WHERE d.state='pending' AND e.brand_id IN (${ph})`).get(...brandIds).n,
      byType:db.prepare(`SELECT type,count(*) n FROM domain_events WHERE brand_id IN (${ph}) GROUP BY type ORDER BY n DESC`).all(...brandIds)};
  }
  // Misma neutralización de fórmulas que la exportación de contactos (celdas que empiezan con = + - @).
  const csv=rows=>['﻿seq,fecha,tipo,marca,entidad,id_entidad,origen,actor,carga',...rows.map(e=>[e.seq,new Date(e.created_at).toISOString(),e.type,e.brand_name,e.entity_kind,e.entity_id,e.source,e.actor_name||'',JSON.stringify(e.payload)].map(csvCell).join(','))].join('\n');

  const requireAdmin=user=>{const u=db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);if(!u||u.disabled||u.role!=='admin')throw fail(403,'La bitácora de eventos es para administración.');};
  async function handle(req,res,path,user){
    if(!path.startsWith('/api/events'))return false;
    requireAdmin(user);const url=new URL(req.url,'http://localhost'),p=url.searchParams;let x;
    const scope=()=>{const ids=crm.brandsFor(user).map(b=>b.id),brand=p.get('brand');if(brand&&brand!=='all'){if(!ids.includes(brand))throw fail(404,'Marca no disponible.');return [brand];}return ids;};
    const filters=()=>({type:p.get('type'),entityKind:p.get('entity'),entityId:p.get('entityId'),q:p.get('q')||'',before:p.get('before'),limit:p.get('limit')});
    if(path==='/api/events'&&req.method==='GET'){const ids=scope(),rows=list(ids,filters());json(res,200,{events:rows,stats:stats(ids),nextBefore:rows.length>=Math.min(500,Math.max(1,Number(p.get('limit'))||200))?rows.at(-1).seq:null});return true;}
    if(path==='/api/events/types'&&req.method==='GET'){json(res,200,{types:types(),entities:ENTITY_KINDS});return true;}
    if(path==='/api/events.csv'&&req.method==='GET'){const rows=list(scope(),{...filters(),limit:500});audit(user,'events.export',String(rows.length));res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="eventos-'+new Date(now()).toISOString().slice(0,10)+'.csv"'});res.end(csv(rows));return true;}
    if((x=path.match(/^\/api\/events\/(\d+)$/))&&req.method==='GET'){const e=get(Number(x[1]));if(!e)throw fail(404,'Evento no encontrado.');crm.requireBrand(user,e.brand_id);json(res,200,{event:view(e),deliveries:deliveriesOf(e.seq)});return true;}
    if((x=path.match(/^\/api\/events\/(\d+)\/retry$/))&&req.method==='POST'){const e=get(Number(x[1]));if(!e)throw fail(404,'Evento no encontrado.');crm.requireBrand(user,e.brand_id);const input=await body(req);retry(e.seq,String(input.subscriber||''),user);json(res,200,{deliveries:deliveriesOf(e.seq)});return true;}
    throw fail(404,'Ruta de eventos no encontrada.');
  }
  return {publish,subscribe,tick,retry,replay,retryFailed,subscriberStats,list,stats,types,deliveriesOf,csv,handle,get:seq=>{const e=get(seq);return e?view(e):null;}};
}
