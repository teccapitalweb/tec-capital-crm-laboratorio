// Eventos de precio y cupo del catálogo (docs/PLAN_HISTORIAL_PRECIO_CUPO.md). Cualquier automatización futura (avisos, llamadas,
// alertas, tableros) lee estos hechos del índice común de eventos de dominio en vez de comparar tablas: cuándo subió o bajó el
// precio de una edición, cómo se movió su cupo y cuándo se agotó, se liberó un lugar o quedaron pocos. Se publican dentro de la
// transacción que hizo el cambio y son idempotentes por clave: repetir el mismo cambio no los duplica.

// «Quedan pocos»: el 20 % del cupo total (mínimo 1).
export const lowSeatsThreshold=capacity=>capacity?Math.max(1,Math.ceil(capacity*0.2)):0;

const num=v=>v===null||v===undefined?null:Number(v);

// Precio regular o por sesión distinto entre la edición anterior y la nueva.
export function publishPriceChange(events,old,row,{actorId=null,source,dedupeKey}){
  if(!events||!old)return null;
  const from=num(old.price_cents),to=num(row.price_cents),sFrom=num(old.session_price_cents),sTo=num(row.session_price_cents);
  if(from===to&&sFrom===sTo)return null;
  const delta=to-from;
  return events.publish({type:'catalogo.precio_cambiado',brandId:row.brand_id,entityKind:'edition',entityId:row.id,actorId,source,dedupeKey:'precio:'+dedupeKey,
    payload:{courseId:row.course_id,name:row.name,currency:row.currency,from,to,sessionFrom:sFrom,sessionTo:sTo,deltaCents:delta,deltaPct:from>0?Math.round(delta/from*1000)/10:null,direction:delta>0?'subio':delta<0?'bajo':'sin_cambio_regular'}});
}

// Cupo disponible antes y después de un cambio (inscripción, baja o edición manual). Publica el cambio y, si aplica, el hito.
export function publishSeatChange(events,edition,before,after,{reason,actorId=null,source,dedupeKey}){
  if(!events||before===null||before===undefined||after===null||after===undefined||before===after)return null;
  const base={courseId:edition.course_id,name:edition.name,capacity:num(edition.capacity)},common={brandId:edition.brand_id,entityKind:'edition',entityId:edition.id,actorId,source};
  const out=[events.publish({...common,type:'edicion.cupo_cambiado',dedupeKey:'cupo:'+dedupeKey,payload:{...base,from:before,to:after,reason}})];
  if(after===0&&before>0)out.push(events.publish({...common,type:'edicion.cupo_agotado',dedupeKey:'cupo-agotado:'+dedupeKey,payload:{...base,from:before,reason}}));
  else if(before===0&&after>0)out.push(events.publish({...common,type:'edicion.cupo_liberado',dedupeKey:'cupo-liberado:'+dedupeKey,payload:{...base,available:after,reason}}));
  else{const thr=lowSeatsThreshold(base.capacity);if(thr&&after>0&&after<=thr&&before>thr)out.push(events.publish({...common,type:'edicion.cupo_bajo',dedupeKey:'cupo-bajo:'+dedupeKey,payload:{...base,available:after,threshold:thr,reason}}));}
  return out;
}

// Línea de tiempo de una edición: precio y estado salen de las versiones guardadas del catálogo (así también cubre el pasado,
// anterior a estos eventos) y el cupo de los eventos de dominio. De la más reciente a la más antigua.
export function timeline(db,editionId,limit=100){
  const out=[];
  const versions=db.prepare('SELECT e.*,u.name actor_name FROM catalogue_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.entity_kind=\'edition\' AND e.entity_id=? ORDER BY e.seq').all(editionId);
  let prev=null;
  for(const v of versions){
    const s=JSON.parse(v.snapshot),who=v.actor_name||null;
    if(!prev)out.push({at:v.created_at,kind:'creada',title:'Edición creada',detail:null,priceCents:num(s.price_cents),currency:s.currency,actor:who});
    else{
      if(num(s.price_cents)!==num(prev.price_cents)){const d=num(s.price_cents)-num(prev.price_cents);out.push({at:v.created_at,kind:d>0?'precio_subio':'precio_bajo',title:d>0?'El precio subió':'El precio bajó',from:num(prev.price_cents),to:num(s.price_cents),deltaPct:prev.price_cents>0?Math.round(d/prev.price_cents*1000)/10:null,currency:s.currency,actor:who});}
      if(num(s.session_price_cents)!==num(prev.session_price_cents))out.push({at:v.created_at,kind:'precio_sesion',title:'Cambió el precio por sesión',from:num(prev.session_price_cents),to:num(s.session_price_cents),currency:s.currency,actor:who});
      if(s.status!==prev.status)out.push({at:v.created_at,kind:'estado',title:({published:'Edición publicada',archived:'Edición archivada',draft:'Edición regresó a borrador'})[s.status]||'Cambió el estado',actor:who});
      if(num(s.capacity)!==num(prev.capacity))out.push({at:v.created_at,kind:'capacidad',title:'Cambió el cupo total',from:num(prev.capacity),to:num(s.capacity),actor:who});
    }
    prev=s;
  }
  const seats=db.prepare("SELECT e.type,e.payload,e.created_at,u.name actor_name FROM domain_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.entity_kind='edition' AND e.entity_id=? AND e.type IN ('edicion.cupo_cambiado','edicion.cupo_agotado','edicion.cupo_liberado','edicion.cupo_bajo') ORDER BY e.seq").all(editionId);
  for(const e of seats){
    const p=JSON.parse(e.payload),who=e.actor_name||null;
    if(e.type==='edicion.cupo_cambiado')out.push({at:e.created_at,kind:'cupo',title:'Cambió el cupo disponible',from:p.from,to:p.to,capacity:p.capacity,reason:p.reason,actor:who});
    else out.push({at:e.created_at,kind:e.type.replace('edicion.',''),title:({'edicion.cupo_agotado':'Se agotó el cupo','edicion.cupo_liberado':'Se liberó un lugar','edicion.cupo_bajo':'Quedan pocos lugares'})[e.type],available:p.available??0,capacity:p.capacity,actor:who});
  }
  // Mismo instante: gana el que se registró después (el cambio de cupo va antes que su hito en el orden de registro).
  out.forEach((x,i)=>{x.ord=i;});
  return out.sort((a,b)=>b.at-a.at||b.ord-a.ord).slice(0,limit).map(({ord,...x})=>x);
}
