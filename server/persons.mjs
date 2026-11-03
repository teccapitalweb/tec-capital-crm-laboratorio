import {randomUUID,createHash} from 'node:crypto';
import {transaction} from './database.mjs';
import {cancelConversationSteps} from './automation.mjs';
import {normalizePhone,normalizeEmail,normalizeName} from './persons-schema.mjs';

// Identidad única de persona (Fase 2 · bloque 2.2). Cada contacto por marca cuelga de una persona; las identidades
// (perfil del laboratorio, teléfono E.164, correo) unen automáticamente entre marcas; cuando sólo coincide el nombre o
// hay conflicto entre identidades queda una candidatura para revisión humana con fusión previa a la vista. El
// consentimiento es de la persona (una baja vale para toda la empresa) y se proyecta a los contactos. El alcance no
// cambia: la ficha enseña sólo las marcas autorizadas; administración ve todo y es quien fusiona.
const fail=(status,message)=>Object.assign(new Error(message),{status});
const text=(v,max)=>typeof v==='string'?v.trim().replace(/\s+/g,' ').slice(0,max):'';
const RANK={unknown:0,opted_in:1,opted_out:2},STATUS=['unknown','opted_in','opted_out'];

export function createPersons({db,crm,events=null,body,json,audit,broadcast,now=Date.now}){
  const get=id=>db.prepare('SELECT * FROM persons WHERE id=?').get(id);
  const roleOf=user=>db.prepare('SELECT role,disabled FROM users WHERE id=?').get(user.id);
  const requireStaff=user=>{const u=roleOf(user);if(!u||u.disabled||u.role==='customer')throw fail(403,'Las personas son para el equipo de atención.');return u;};
  const requireAdmin=user=>{const u=roleOf(user);if(!u||u.disabled||u.role!=='admin')throw fail(403,'Esta acción requiere un administrador.');};
  const owner=(kind,value)=>value?db.prepare('SELECT person_id FROM person_identities WHERE kind=? AND value=?').get(kind,value)?.person_id||null:null;
  const contactsOf=id=>db.prepare('SELECT * FROM contacts WHERE persona_id=? ORDER BY created_at').all(id);
  const visibleBrands=user=>new Set(crm.brandsFor(user).map(b=>b.id));
  // Identidades respaldadas por un conjunto de contactos: lo único de la persona que ve quien no es administración.
  const identitySet=cs=>new Set(cs.flatMap(c=>[c.source_user_id&&'profile:'+c.source_user_id,normalizePhone(c.phone)&&'phone:'+normalizePhone(c.phone),normalizeEmail(c.email)&&'email:'+normalizeEmail(c.email)].filter(Boolean)));
  // Proyecta el consentimiento vigente de la persona a todos sus contactos (tras fusiones o reasignaciones).
  function project(personId){const p=get(personId);if(!p||p.consent_status==='unknown')return;for(const c of contactsOf(personId))db.prepare('INSERT INTO contact_consent(contact_id,brand_id,status,source,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET status=excluded.status,source=excluded.source,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at WHERE excluded.status!=contact_consent.status').run(c.id,c.brand_id,p.consent_status,'person',p.consent_note,p.consent_actor_id,now());}
  function candidate(a,b,reason,detail=''){
    if(!a||!b||a===b)return;const [x,y]=[a,b].sort();
    db.prepare('INSERT OR IGNORE INTO person_candidates(id,person_a,person_b,reason,detail,status,created_at) VALUES(?,?,?,?,?,\'pending\',?)').run(randomUUID(),x,y,reason,detail.slice(0,200),now());
  }
  // Reclama una identidad para la persona; si ya es de otra, deja una candidatura de conflicto y no la mueve.
  function claim(kind,value,personId,source){
    if(!value)return;const current=owner(kind,value);
    if(!current)db.prepare('INSERT INTO person_identities(kind,value,person_id,source,created_at) VALUES(?,?,?,?,?)').run(kind,value,personId,source,now());
    else if(current!==personId)candidate(current,personId,'identity_conflict',kind==='phone'?'Mismo teléfono '+value:kind==='email'?'Mismo correo '+value:'Mismo perfil');
  }
  // Resuelve (o crea) la persona de un contacto a partir de sus identidades. Dentro de la transacción del llamador.
  function attach(contact,source='contact'){
    const c=typeof contact==='string'?db.prepare('SELECT * FROM contacts WHERE id=?').get(contact):contact;if(!c)return null;
    const phone=normalizePhone(c.phone),email=normalizeEmail(c.email),t=now();
    let pid=c.persona_id||(c.source_user_id&&owner('profile',c.source_user_id))||owner('phone',phone)||owner('email',email)||null;
    if(!pid){pid=randomUUID();db.prepare('INSERT INTO persons(id,name,phone,email,source_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(pid,c.name,phone,email,c.source_user_id||null,t,t);}
    else{const p=get(pid);if(c.source_user_id&&!p.source_user_id&&!db.prepare('SELECT 1 FROM persons WHERE source_user_id=?').get(c.source_user_id))db.prepare('UPDATE persons SET source_user_id=? WHERE id=?').run(c.source_user_id,pid);db.prepare("UPDATE persons SET phone=CASE WHEN phone='' THEN ? ELSE phone END,email=CASE WHEN email='' THEN ? ELSE email END,updated_at=? WHERE id=?").run(phone,email,t,pid);}
    if(c.source_user_id)claim('profile',c.source_user_id,pid,source);claim('phone',phone,pid,source);claim('email',email,pid,source);
    if(c.persona_id!==pid)db.prepare('UPDATE contacts SET persona_id=? WHERE id=?').run(pid,c.id);
    // Mismo nombre completo en otra persona: candidatura para revisar (nunca une sola).
    const n=normalizeName(c.name);if(n.includes(' '))for(const o of db.prepare('SELECT id FROM persons WHERE id!=? AND lower(name)=?').all(pid,c.name.trim().toLowerCase()))candidate(o.id,pid,'name','Mismo nombre «'+c.name.trim()+'»');
    // Proyección del consentimiento de la persona al contacto nuevo.
    const p=get(pid);if(p.consent_status!=='unknown'){const k=db.prepare('SELECT status FROM contact_consent WHERE contact_id=?').get(c.id);if(!k||RANK[p.consent_status]>RANK[k.status])db.prepare('INSERT INTO contact_consent(contact_id,brand_id,status,source,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET status=excluded.status,source=excluded.source,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at').run(c.id,c.brand_id,p.consent_status,'person',p.consent_note,p.consent_actor_id,t);}
    return pid;
  }
  // ---- consentimiento a nivel persona (lo llaman contacts.setConsent/recordInbound y la ficha de persona)
  const consentOf=id=>{const p=get(id);return {status:p.consent_status,source:p.consent_source,note:p.consent_note,actor_id:p.consent_actor_id,updated_at:p.consent_updated_at};};
  const conversationsOfPerson=id=>db.prepare('SELECT co.conversation_id id FROM conversation_opportunities co JOIN opportunities o ON o.id=co.opportunity_id JOIN contacts c ON c.id=o.contact_id WHERE c.persona_id=?').all(id).map(r=>r.id);
  function writeConsent(personId,status,source,note,actor,brandId=null){
    const p=get(personId),t=now();if(!p)return;
    db.prepare('UPDATE persons SET consent_status=?,consent_source=?,consent_note=?,consent_actor_id=?,consent_updated_at=?,revision=revision+1,updated_at=? WHERE id=?').run(status,source,note,actor,t,t,personId);
    db.prepare('INSERT INTO person_consent_events(person_id,brand_id,status,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(personId,brandId,status,source,note,actor,t);
    for(const c of contactsOf(personId)){
      db.prepare('INSERT INTO contact_consent(contact_id,brand_id,status,source,note,actor_id,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(contact_id) DO UPDATE SET status=excluded.status,source=excluded.source,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at').run(c.id,c.brand_id,status,source,note,actor,t);
      db.prepare('INSERT INTO contact_consent_events(contact_id,brand_id,status,source,note,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(c.id,c.brand_id,status,source,note,actor,t);
    }
    if(status==='opted_out'){for(const id of conversationsOfPerson(personId))cancelConversationSteps(db,id,'contact_opted_out',t);
      for(const b of new Set(contactsOf(personId).map(c=>c.brand_id)))events?.publish({type:'baja.registrada',brandId:b,entityKind:'person',entityId:personId,payload:{source,note:String(note||'').slice(0,120),originBrand:brandId},actorId:actor||null,source:'consent',dedupeKey:'baja.registrada:'+personId+':'+b+':'+t});}
  }
  function setConsentForContact(c,status,source,note,actor){const pid=c.persona_id||attach(c);writeConsent(pid,status,source,note,actor,c.brand_id);}
  // ---- vistas
  const brandName=id=>db.prepare('SELECT name FROM brands WHERE id=?').get(id)?.name||id;
  function summary(p,allowed,isAdmin=false){
    const contacts=contactsOf(p.id),mine=contacts.filter(c=>allowed.has(c.brand_id)),ids=mine.map(c=>c.id),ph=ids.map(()=>'?').join(',')||'NULL',vis=identitySet(mine);
    const opps=db.prepare(`SELECT stage,count(*) n FROM opportunities WHERE contact_id IN (${ph}) GROUP BY stage`).all(...ids);
    return {id:p.id,name:p.name,phone:isAdmin||vis.has('phone:'+p.phone)?p.phone:'',email:isAdmin||vis.has('email:'+p.email)?p.email:'',canEdit:isAdmin||contacts.every(c=>allowed.has(c.brand_id)),profile:Boolean(p.source_user_id),testNumber:p.source_user_id?db.prepare('SELECT test_number FROM users WHERE id=?').get(p.source_user_id)?.test_number||null:null,consent:p.consent_status,revision:p.revision,created_at:p.created_at,updated_at:p.updated_at,
      brands:mine.map(c=>({id:c.brand_id,name:brandName(c.brand_id),contactId:c.id})),otherBrands:contacts.length-mine.length,
      opportunities:opps.reduce((n,r)=>n+r.n,0),won:opps.find(r=>r.stage==='ganada')?.n||0,enrollments:db.prepare(`SELECT count(*) n FROM enrollments WHERE contact_id IN (${ph}) AND status='enrolled'`).get(...ids).n,
      paidCents:db.prepare(`SELECT COALESCE(sum(amount_cents),0) n FROM orders WHERE contact_id IN (${ph}) AND status='paid'`).get(...ids).n,lastActivity:db.prepare(`SELECT max(updated_at) m FROM opportunities WHERE contact_id IN (${ph})`).get(...ids).m};
  }
  function list(user,params){
    const isAdmin=requireStaff(user).role==='admin',allowed=visibleBrands(user),brand=params.get('brand'),q=normalizeName(params.get('q')||'').slice(0,80),limit=Math.min(200,Math.max(1,Number(params.get('limit'))||100));
    const ids=[...allowed].filter(id=>!brand||brand==='all'||id===brand);if(!ids.length)return [];
    const rows=db.prepare(`SELECT DISTINCT p.* FROM persons p JOIN contacts c ON c.persona_id=p.id WHERE c.brand_id IN (${ids.map(()=>'?').join(',')}) ORDER BY p.updated_at DESC LIMIT 2000`).all(...ids);
    const digits=q.replace(/\D/g,'');
    return rows.filter(p=>!q||normalizeName(p.name).includes(q)||(digits.length>=4&&p.phone.includes(digits))||p.email.includes(q)).slice(0,limit).map(p=>summary(p,allowed,isAdmin));
  }
  function detail(id,user){
    requireStaff(user);const p=get(id);if(!p)throw fail(404,'Persona no encontrada.');
    const allowed=visibleBrands(user),contacts=contactsOf(id),mine=contacts.filter(c=>allowed.has(c.brand_id));
    if(!mine.length)throw fail(404,'Persona no encontrada.');   // sin contacto en una marca autorizada, no existe para este usuario
    const ids=mine.map(c=>c.id),ph=ids.map(()=>'?').join(','),isAdmin=roleOf(user).role==='admin';
    // El consentimiento es de toda la empresa, pero quién lo registró, desde qué marca y con qué nota sólo se enseña
    // para las marcas autorizadas (o a administración): el estado y la fecha sí, porque rigen para todas.
    const history=db.prepare('SELECT e.status,e.source,e.note,e.created_at,e.brand_id,u.name actor_name,b.name brand_name FROM person_consent_events e LEFT JOIN users u ON u.id=e.actor_id LEFT JOIN brands b ON b.id=e.brand_id WHERE e.person_id=? ORDER BY e.seq DESC LIMIT 30').all(id);
    const canSee=h=>isAdmin||(h.brand_id!==null&&allowed.has(h.brand_id));
    const redact=h=>canSee(h)?h:{status:h.status,source:h.source,note:'',created_at:h.created_at,brand_id:null,actor_name:null,brand_name:null,redacted:true};
    const current=consentOf(id),lastEvent=history[0];
    const vis=identitySet(mine);
    return {person:summary(p,allowed,isAdmin),identities:db.prepare('SELECT kind,value,source,created_at FROM person_identities WHERE person_id=? ORDER BY kind').all(id).filter(i=>isAdmin||vis.has(i.kind+':'+i.value)).map(i=>i.kind==='profile'?{...i,value:'perfil del laboratorio'}:i),
      consent:lastEvent&&!canSee(lastEvent)?{...current,note:'',actor_id:null,redacted:true}:current,consentHistory:history.map(redact),
      contacts:mine.map(c=>({id:c.id,brand_id:c.brand_id,brand_name:brandName(c.brand_id),name:c.name,phone:c.phone,email:c.email,source:c.source,created_at:c.created_at,tags:db.prepare('SELECT t.name,t.color FROM contact_tag_links l JOIN contact_tags t ON t.id=l.tag_id WHERE l.contact_id=?').all(c.id)})),
      opportunities:db.prepare(`SELECT o.id,o.brand_id,o.stage,o.updated_at,o.created_at,k.title course_title,e.name edition_name,u.name owner_name,(SELECT co.conversation_id FROM conversation_opportunities co WHERE co.opportunity_id=o.id) conversation_id FROM opportunities o JOIN courses k ON k.id=o.course_id LEFT JOIN editions e ON e.id=o.edition_id LEFT JOIN users u ON u.id=o.owner_id WHERE o.contact_id IN (${ph}) ORDER BY o.updated_at DESC`).all(...ids).map(o=>({...o,brand_name:brandName(o.brand_id)})),
      orders:db.prepare(`SELECT o.id,o.brand_id,o.reference,o.amount_cents,o.currency,o.status,o.method,o.paid_at,o.created_at,k.title course_title,e.name edition_name FROM orders o JOIN courses k ON k.id=o.course_id JOIN editions e ON e.id=o.edition_id WHERE o.contact_id IN (${ph}) ORDER BY o.created_at DESC`).all(...ids).map(o=>({...o,brand_name:brandName(o.brand_id)})),
      enrollments:db.prepare(`SELECT en.id,en.brand_id,en.status,en.created_at,en.cancelled_at,k.title course_title,e.name edition_name,e.run_status,e.id edition_id,(SELECT count(*) FROM attendance a JOIN edition_sessions s ON s.id=a.session_id WHERE a.enrollment_id=en.id AND a.status IN ('present','late')) attended,(SELECT count(*) FROM edition_sessions s WHERE s.edition_id=en.edition_id AND s.status='done') held FROM enrollments en JOIN courses k ON k.id=en.course_id JOIN editions e ON e.id=en.edition_id WHERE en.contact_id IN (${ph}) ORDER BY en.created_at DESC`).all(...ids).map(e=>({...e,brand_name:brandName(e.brand_id)})),
      candidates:roleOf(user).role==='admin'?db.prepare("SELECT c.*,pa.name name_a,pb.name name_b FROM person_candidates c JOIN persons pa ON pa.id=c.person_a JOIN persons pb ON pb.id=c.person_b WHERE (c.person_a=? OR c.person_b=?) AND c.status='pending'").all(id,id):[]};
  }
  function update(id,input,user){
    const u=requireStaff(user),p=get(id);if(!p)throw fail(404,'Persona no encontrada.');
    const cs=contactsOf(id),allowed=visibleBrands(user);if(!cs.some(c=>allowed.has(c.brand_id)))throw fail(404,'Persona no encontrada.');
    // Los datos de la persona valen para toda la empresa: los edita administración o quien tiene acceso a todas sus marcas.
    if(u.role!=='admin'&&!cs.every(c=>allowed.has(c.brand_id)))throw fail(403,'Esta persona tiene contactos en marcas a las que no tienes acceso: edita el contacto de tu marca o pide el cambio a administración.');
    if(!Number.isInteger(input.expectedRevision)||input.expectedRevision!==p.revision)throw fail(409,'La persona cambió. Recárgala.');
    const name=input.name===undefined?p.name:text(input.name,100);if(name.length<2)throw fail(400,'Escribe el nombre de la persona.');
    const rawPhone=input.phone===undefined?p.phone:text(input.phone,40),phone=rawPhone?normalizePhone(rawPhone):'';if(rawPhone&&!phone)throw fail(400,'El teléfono no se reconoce: usa 10 dígitos de México o el formato internacional +52…');
    const rawEmail=input.email===undefined?p.email:text(input.email,150),email=rawEmail?normalizeEmail(rawEmail):'';if(rawEmail&&!email)throw fail(400,'El correo no es válido.');
    for(const [kind,value] of [['phone',phone],['email',email]]){const o=owner(kind,value);if(value&&o&&o!==id)throw fail(409,(kind==='phone'?'Ese teléfono':'Ese correo')+' ya pertenece a otra persona. Revisa si son la misma y fusiónalas.');}
    transaction(db,()=>{db.prepare('UPDATE persons SET name=?,phone=?,email=?,revision=revision+1,updated_at=? WHERE id=?').run(name,phone,email,now(),id);claim('phone',phone,id,'staff');claim('email',email,id,'staff');});
    audit(user,'person.update',id);for(const b of new Set(contactsOf(id).map(c=>c.brand_id)))broadcast('crm',null,{brandId:b});return summary(get(id),allowed,u.role==='admin');
  }
  function setConsent(id,input,user){
    requireStaff(user);const p=get(id);if(!p)throw fail(404,'Persona no encontrada.');const mine=contactsOf(id).filter(c=>visibleBrands(user).has(c.brand_id));if(!mine.length)throw fail(404,'Persona no encontrada.');
    const status=input.status,note=text(input.note,200);if(!STATUS.includes(status))throw fail(400,'Estado de consentimiento no válido.');
    return transaction(db,()=>{
      if(p.consent_status===status)return {...consentOf(id),unchanged:true};
      if(p.consent_status==='opted_out'){requireAdmin(user);if(note.length<5)throw fail(400,'Para reactivar a una persona que pidió la baja, administración debe explicar el motivo (mínimo 5 caracteres).');}
      writeConsent(id,status,'staff',note,user.id,mine[0].brand_id);audit(user,'person.consent',id);for(const b of new Set(contactsOf(id).map(c=>c.brand_id)))broadcast('crm',null,{brandId:b});return consentOf(id);
    });
  }
  // ---- revisión y fusión (administración)
  function candidates(user){
    requireAdmin(user);
    return db.prepare("SELECT c.*,pa.name name_a,pa.phone phone_a,pa.email email_a,pb.name name_b,pb.phone phone_b,pb.email email_b FROM person_candidates c JOIN persons pa ON pa.id=c.person_a JOIN persons pb ON pb.id=c.person_b WHERE c.status='pending' ORDER BY c.created_at DESC LIMIT 100").all()
      .map(c=>({...c,brands_a:contactsOf(c.person_a).map(x=>brandName(x.brand_id)),brands_b:contactsOf(c.person_b).map(x=>brandName(x.brand_id))}));
  }
  function dismiss(id,user){requireAdmin(user);if(!db.prepare("UPDATE person_candidates SET status='dismissed',decided_by=?,decided_at=? WHERE id=? AND status='pending'").run(user.id,now(),id).changes)throw fail(404,'Candidatura no encontrada o ya decidida.');audit(user,'person.candidate.dismiss',id);return true;}
  function plan(keepId,mergeId,user){
    requireAdmin(user);if(keepId===mergeId)throw fail(400,'Elige dos personas distintas.');
    const keep=get(keepId),merge=get(mergeId);if(!keep||!merge)throw fail(404,'Persona no encontrada.');
    const kc=contactsOf(keep.id),mc=contactsOf(merge.id),problems=[];
    if(keep.source_user_id&&merge.source_user_id&&keep.source_user_id!==merge.source_user_id)problems.push('Las dos personas son perfiles distintos del laboratorio; no se pueden fusionar.');
    if(merge.source_user_id&&!keep.source_user_id)problems.push('La persona que se une tiene perfil del laboratorio: elígela como principal para no perder el vínculo.');
    const shared=mc.filter(c=>kc.some(k=>k.brand_id===c.brand_id)).map(c=>brandName(c.brand_id));if(shared.length)problems.push('Ambas tienen contacto en '+shared.join(', ')+': fusiona primero esos contactos desde la marca.');
    const moves={contacts:mc.length,identities:db.prepare('SELECT count(*) n FROM person_identities WHERE person_id=?').get(merge.id).n,consent:RANK[merge.consent_status]>RANK[keep.consent_status]?merge.consent_status:null,fill:{phone:!keep.phone&&Boolean(merge.phone),email:!keep.email&&Boolean(merge.email)}};
    const token=createHash('sha256').update(JSON.stringify([keep.id,keep.revision,merge.id,merge.revision,kc.map(c=>c.id),mc.map(c=>c.id)])).digest('hex');
    return {keep:summary(keep,new Set(crm.brandsFor(user).map(b=>b.id))),merge:summary(merge,new Set(crm.brandsFor(user).map(b=>b.id))),moves,problems,canMerge:problems.length===0,previewToken:token};
  }
  function applyMerge(input,user){
    const out=transaction(db,()=>{
      const p=plan(text(input.keepId,60),text(input.mergeId,60),user);if(p.problems.length)throw fail(409,p.problems[0]);
      if(input.previewToken!==p.previewToken)throw fail(409,'Las personas cambiaron desde la vista previa. Vuelve a revisarlas.');
      const keep=get(p.keep.id),merge=get(p.merge.id),t=now();
      db.prepare('UPDATE contacts SET persona_id=? WHERE persona_id=?').run(keep.id,merge.id);
      db.prepare('UPDATE person_identities SET person_id=? WHERE person_id=?').run(keep.id,merge.id);
      db.prepare('UPDATE person_consent_events SET person_id=? WHERE person_id=?').run(keep.id,merge.id);
      db.prepare("UPDATE persons SET phone=CASE WHEN phone='' THEN ? ELSE phone END,email=CASE WHEN email='' THEN ? ELSE email END,source_user_id=COALESCE(source_user_id,?),revision=revision+1,updated_at=? WHERE id=?").run(merge.phone,merge.email,merge.source_user_id,t,keep.id);
      db.prepare('UPDATE persons SET source_user_id=NULL WHERE id=?').run(merge.id);
      if(p.moves.consent)writeConsent(keep.id,merge.consent_status,'merge','Heredado al fusionar con «'+merge.name+'»',user.id,null);else project(keep.id);   // los contactos que llegan reciben el consentimiento vigente
      db.prepare("UPDATE person_candidates SET status=CASE WHEN status='pending' THEN 'merged' ELSE status END,decided_by=COALESCE(decided_by,?),decided_at=COALESCE(decided_at,?) WHERE person_a IN (?,?) AND person_b IN (?,?)").run(user.id,t,keep.id,merge.id,keep.id,merge.id);
      for(const c of db.prepare('SELECT * FROM person_candidates WHERE person_a=? OR person_b=?').all(merge.id,merge.id)){const other=c.person_a===merge.id?c.person_b:c.person_a;db.prepare('DELETE FROM person_candidates WHERE id=?').run(c.id);if(other!==keep.id&&c.status==='pending')candidate(keep.id,other,c.reason,c.detail);}
      db.prepare('INSERT INTO person_merges(id,kept_id,merged_id,merged_snapshot,moved,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),keep.id,merge.id,JSON.stringify(merge),JSON.stringify(p.moves),user.id,t);
      db.prepare('DELETE FROM persons WHERE id=?').run(merge.id);
      for(const b of new Set(contactsOf(keep.id).map(c=>c.brand_id)))events?.publish({type:'persona.fusionada',brandId:b,entityKind:'person',entityId:keep.id,payload:{mergedId:merge.id,mergedName:merge.name,contacts:p.moves.contacts},actorId:user.id,source:'persons',dedupeKey:'persona.fusionada:'+merge.id+':'+b});
      return {keepId:keep.id,mergedId:merge.id,moved:p.moves,brands:[...new Set(contactsOf(keep.id).map(c=>c.brand_id))]};
    });
    audit(user,'person.merged',out.keepId);for(const b of out.brands)broadcast('crm',null,{brandId:b});return out;
  }
  // Tras fusionar dos contactos de la misma marca: si la persona del contacto absorbido se queda sin contactos, se une a la que queda.
  function afterContactMerge(keepContact,mergedPersonId,user){
    const keepPid=keepContact.persona_id||attach(keepContact);if(!mergedPersonId||mergedPersonId===keepPid)return;
    if(contactsOf(mergedPersonId).length)return;
    const merge=get(mergedPersonId);if(!merge)return;const t=now();
    db.prepare('UPDATE person_identities SET person_id=? WHERE person_id=?').run(keepPid,mergedPersonId);db.prepare('UPDATE person_consent_events SET person_id=? WHERE person_id=?').run(keepPid,mergedPersonId);
    db.prepare("UPDATE persons SET phone=CASE WHEN phone='' THEN ? ELSE phone END,email=CASE WHEN email='' THEN ? ELSE email END,revision=revision+1,updated_at=? WHERE id=?").run(merge.phone,merge.email,t,keepPid);
    db.prepare('UPDATE persons SET source_user_id=NULL WHERE id=?').run(mergedPersonId);db.prepare("UPDATE persons SET source_user_id=COALESCE(source_user_id,?) WHERE id=?").run(merge.source_user_id,keepPid);
    db.prepare('DELETE FROM person_candidates WHERE person_a=? OR person_b=?').run(mergedPersonId,mergedPersonId);
    db.prepare('INSERT INTO person_merges(id,kept_id,merged_id,merged_snapshot,moved,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),keepPid,mergedPersonId,JSON.stringify(merge),JSON.stringify({via:'contact_merge'}),user?.id||null,t);
    db.prepare('DELETE FROM persons WHERE id=?').run(mergedPersonId);project(keepPid);
  }

  async function handle(req,res,path,user){
    if(!path.startsWith('/api/persons'))return false;
    const p=new URL(req.url,'http://localhost').searchParams;let x;
    if(path==='/api/persons'&&req.method==='GET'){json(res,200,{persons:list(user,p)});return true;}
    if(path==='/api/persons/candidates'&&req.method==='GET'){json(res,200,{candidates:candidates(user)});return true;}
    if((x=path.match(/^\/api\/persons\/candidates\/([a-f0-9-]{36})\/dismiss$/))&&req.method==='POST'){dismiss(x[1],user);json(res,200,{ok:true});return true;}
    if(path==='/api/persons/merge-preview'&&req.method==='POST'){const i=await body(req);json(res,200,{plan:plan(text(i.keepId,60),text(i.mergeId,60),user)});return true;}
    if(path==='/api/persons/merge'&&req.method==='POST'){json(res,200,applyMerge(await body(req),user));return true;}
    if((x=path.match(/^\/api\/persons\/([a-f0-9-]{36})(?:\/(consent))?$/))){
      if(!x[2]&&req.method==='GET'){json(res,200,detail(x[1],user));return true;}
      if(!x[2]&&req.method==='PATCH'){json(res,200,{person:update(x[1],await body(req),user)});return true;}
      if(x[2]==='consent'&&req.method==='PUT'){json(res,200,{consent:setConsent(x[1],await body(req),user)});return true;}
      throw fail(405,'Método no permitido.');
    }
    throw fail(404,'Ruta de personas no encontrada.');
  }
  return {handle,attach,setConsentForContact,writeConsent,consentOf,afterContactMerge,list,detail,plan,applyMerge,candidates};
}
