import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('campañas por API: permisos, apagado por marca, vista previa con motivos, confirmación del público, envío idempotente, respuestas, bajas, separación mínima, toma humana y cancelación',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'crm-campaigns-')),code=randomUUID(),password='Password-campaigns-2026!';let logs='';
 const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
 t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
 async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
 const sleep=ms=>new Promise(r=>setTimeout(r,ms));
 const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),one=(sql,...a)=>{const d=db();try{return d.prepare(sql).get(...a);}finally{d.close();}},run=(sql,...a)=>{const d=db();try{d.prepare(sql).run(...a);}finally{d.close();}};
 assert.equal((await fetch(origin+'/campaigns.js')).status,200);

 const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
 const people={};for(const [u,n] of [['ana','Ana Pérez'],['beto','Beto Ruiz'],['carla','Carla Soto'],['dora','Dora Vega']])people[u]=await call('/api/auth/register','',{username:u,name:n,password});
 const convs={};for(const u of Object.keys(people))convs[u]=(await call('/api/conversations',people[u].cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
 const brandId=convs.ana.brand_id,contact=Object.fromEntries(Object.keys(people).map(u=>[u,one('SELECT c.id FROM contacts c JOIN users x ON x.id=c.source_user_id WHERE x.username=? AND c.brand_id=?',u,brandId).id]));
 const consent=(u,status)=>call('/api/crm/contacts/'+contact[u]+'/consent',admin.cookie,{status,note:'prueba de campañas'},'PUT');
 await consent('ana','opted_in');await consent('beto','opted_in');await consent('dora','opted_out');
 const template=(await call('/api/catalogue',admin.cookie)).templates.find(x=>x.brand_id===brandId&&x.status==='approved'&&(!x.course_id||x.course_id==='aves')&&!x.edition_id);assert.ok(template,'plantilla aprobada disponible');

 // permisos y validación
 await call('/api/campaigns','',undefined,'GET',401);await call('/api/campaigns',people.ana.cookie,undefined,'GET',403);await call('/api/campaigns/settings',people.ana.cookie,undefined,'GET',403);
 const base={brandId,title:'Reactivación de interesados',templateId:template.id,segment:{}};
 await call('/api/campaigns',admin.cookie,{...base,title:''},'POST',400);await call('/api/campaigns',admin.cookie,{...base,templateId:randomUUID()},'POST',400);
 await call('/api/campaigns',admin.cookie,{...base,segment:{stages:['inexistente']}},'POST',400);await call('/api/campaigns',admin.cookie,{...base,segment:{tagIds:[randomUUID()]}},'POST',400);
 await call('/api/campaigns',admin.cookie,{...base,segment:{channel:'sms'}},'POST',400);await call('/api/campaigns',admin.cookie,{...base,segment:{inactiveDays:0}},'POST',400);
 const draft=(await call('/api/campaigns',admin.cookie,{...base,clientRef:'campana-prueba-1'},'POST',201)).campaign;
 assert.equal(draft.status,'draft');assert.equal(draft.requireConsent,true);
 assert.equal((await call('/api/campaigns',admin.cookie,{...base,clientRef:'campana-prueba-1'},'POST',201)).campaign.id,draft.id,'la misma referencia no duplica la campaña');
 assert.equal(one('SELECT count(*) n FROM campaigns').n,1);

 // vista previa: no escribe nada y explica a quién excluye
 const counters=()=>{const d=db();try{return ['messages','automation_steps','campaign_recipients','tasks','notifications'].map(n=>d.prepare('SELECT count(*) n FROM '+n).get().n).join('-');}finally{d.close();}};
 const before=counters();
 const p1=(await call('/api/campaigns/'+draft.id+'/preview',admin.cookie,{})).preview;
 assert.equal(counters(),before);assert.equal(p1.total,4);assert.equal(p1.eligible,2);assert.equal(p1.willSend,2);assert.equal(p1.enabled,false);
 assert.deepEqual(Object.fromEntries(p1.excluded.map(e=>[e.reason,e.count])),{no_consent:1,opted_out:1});assert.ok(p1.message.text.length>0);assert.equal(p1.message.category,'marketing');
 assert.equal(p1.sample.length,2);assert.ok(p1.cost.estimate>0);

 // apagado por omisión: ni con las campañas encendidas se programa si la automatización de la marca está apagada
 await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:draft.revision,confirmAudience:2},'POST',409);
 const settings0=(await call('/api/campaigns/settings',admin.cookie)).settings.find(s=>s.brand_id===brandId);assert.equal(settings0.enabled,0);assert.equal(settings0.min_gap_hours,72);
 await call('/api/campaigns/settings/'+brandId,admin.cookie,{enabled:true,expectedRevision:99},'PATCH',409);
 await call('/api/campaigns/settings/'+brandId,admin.cookie,{enabled:true,paceSeconds:0,expectedRevision:settings0.revision},'PATCH',400);
 await call('/api/campaigns/settings/'+brandId,admin.cookie,{enabled:true,paceSeconds:1,expectedRevision:settings0.revision},'PATCH');
 await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:draft.revision,confirmAudience:2},'POST',409);
 const automation=await call('/api/automation',admin.cookie);
 await call('/api/automation/brands/'+brandId,admin.cookie,{enabled:true,expectedRevision:automation.brands.find(b=>b.id===brandId).revision},'PATCH');

 // el público debe confirmarse con el número de la vista previa
 await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:draft.revision},'POST',400);
 await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:draft.revision,confirmAudience:3},'POST',409);
 await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:99,confirmAudience:2},'POST',409);
 await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:draft.revision,confirmAudience:2,scheduledAt:Date.now()+100*86400000},'POST',400);
 assert.equal(counters(),before);
 const scheduled=(await call('/api/campaigns/'+draft.id+'/schedule',admin.cookie,{expectedRevision:draft.revision,confirmAudience:2})).campaign;
 assert.equal(scheduled.status,'scheduled');assert.equal(scheduled.audienceConfirmed,2);
 await call('/api/campaigns/'+draft.id,admin.cookie,{expectedRevision:scheduled.revision,title:'Otro'},'PATCH',409);

 // envío: un paso por destinatario, espaciados, sin duplicar aunque el escaneo se repita
 let done;for(let i=0;i<40&&!(done=(await call('/api/campaigns/'+draft.id,admin.cookie)).campaign).status.match(/completed/);i++)await sleep(500);
 assert.equal(done.status,'completed');assert.equal(done.stats.recipients,2);assert.equal(done.stats.sent,2);assert.equal(done.stats.queued,0);assert.equal(done.stats.skipped,0);assert.ok(done.stats.cost.estimate>0);
 await sleep(2500);
 assert.equal(one("SELECT count(*) n FROM messages WHERE client_ref LIKE 'campaign:%'").n,2);assert.equal(one("SELECT count(*) n FROM automation_steps WHERE kind='campaign.send'").n,2);
 for(const u of ['ana','beto']){const m=(await call('/api/conversations/'+convs[u].id+'/messages',people[u].cookie)).messages.filter(x=>x.sender_kind==='automation'&&x.category==='marketing');assert.equal(m.length,1,u);assert.ok(m[0].text.length>0);}
 for(const u of ['carla','dora'])assert.equal((await call('/api/conversations/'+convs[u].id+'/messages',people[u].cookie)).messages.filter(x=>x.sender_kind==='automation').length,0,u+' no debía recibir la campaña');
 const events=(await call('/api/campaigns/'+draft.id+'/events',admin.cookie)).events.map(e=>e.kind);assert.deepEqual(events,['created','scheduled','launched','queued','completed']);
 const rec=await call('/api/campaigns/'+draft.id+'/recipients',admin.cookie);assert.equal(rec.total,2);assert.ok(rec.recipients.every(r=>r.state==='sent'&&!r.replied));

 // resultados: respuesta del cliente y baja posterior al envío
 await call('/api/conversations/'+convs.ana.id+'/messages',people.ana.cookie,{text:'Gracias, me interesa el curso',clientRef:randomUUID()},'POST',201);
 await call('/api/conversations/'+convs.beto.id+'/messages',people.beto.cookie,{text:'baja',clientRef:randomUUID()},'POST',201);
 const after=(await call('/api/campaigns/'+draft.id,admin.cookie)).campaign.stats;assert.equal(after.replied,2);assert.equal(after.optedOut,1);
 assert.equal((await call('/api/campaigns/'+draft.id+'/recipients?state=sent',admin.cookie)).recipients.filter(r=>r.replied).length,2);

 // segunda campaña: separación mínima, bajas y consentimiento flexible
 const second=(await call('/api/campaigns',admin.cookie,{...base,title:'Segunda',requireConsent:false},'POST',201)).campaign;
 const p2=(await call('/api/campaigns/'+second.id+'/preview',admin.cookie,{})).preview;
 const ex=Object.fromEntries(p2.excluded.map(e=>[e.reason,e.count]));assert.equal(ex.opted_out,2);assert.equal(Object.values(ex).reduce((n,v)=>n+v,0),3,'ana queda fuera por la campaña reciente o por esperar a una persona');assert.equal(p2.eligible,1);   // carla (sin registro) sí; ana ya recibió; beto y dora pidieron la baja
 // toma humana: una persona atiende a Carla
 run('UPDATE conversations SET assigned_to=? WHERE id=?',admin.cookie&&one('SELECT id FROM users WHERE username=?','admin').id,convs.carla.id);
 const p3=(await call('/api/campaigns/'+second.id+'/preview',admin.cookie,{})).preview;assert.equal(p3.eligible,0);assert.equal(p3.excluded.find(e=>e.reason==='human_control').count,1);
 await call('/api/campaigns/'+second.id+'/schedule',admin.cookie,{expectedRevision:second.revision,confirmAudience:0},'POST',409);
 run('UPDATE conversations SET assigned_to=NULL WHERE id=?',convs.carla.id);

 // segmento por etiqueta y por días sin responder
 const tag=(await call('/api/crm/tags',admin.cookie,{brandId,name:'Promo noviembre'},'POST',201)).tag;
 await call('/api/crm/contacts/'+contact.carla+'/tags',admin.cookie,{tagIds:[tag.id]},'PUT');
 const tagged=(await call('/api/campaigns',admin.cookie,{...base,title:'Por etiqueta',requireConsent:false,segment:{tagIds:[tag.id]}},'POST',201)).campaign;
 assert.equal((await call('/api/campaigns/'+tagged.id+'/preview',admin.cookie,{})).preview.total,1);
 const inactive=(await call('/api/campaigns',admin.cookie,{...base,title:'Inactivos',requireConsent:false,segment:{inactiveDays:30}},'POST',201)).campaign;
 assert.equal((await call('/api/campaigns/'+inactive.id+'/preview',admin.cookie,{})).preview.total,2);   // carla y dora no han escrito; ana y beto respondieron hoy
 const stagedOut=(await call('/api/campaigns',admin.cookie,{...base,title:'Ganadas',requireConsent:false,segment:{stages:['ganada']}},'POST',201)).campaign;
 assert.equal((await call('/api/campaigns/'+stagedOut.id+'/preview',admin.cookie,{})).preview.total,0);

 // cancelar una programada: no se envía nada y repetirlo es inocuo
 const sent0=one("SELECT count(*) n FROM messages WHERE client_ref LIKE 'campaign:%'").n;
 await call('/api/campaigns/settings/'+brandId,admin.cookie,{minGapHours:0,expectedRevision:(await call('/api/campaigns/settings',admin.cookie)).settings.find(s=>s.brand_id===brandId).revision},'PATCH');
 const later=(await call('/api/campaigns/'+tagged.id+'/schedule',admin.cookie,{expectedRevision:tagged.revision,confirmAudience:1,scheduledAt:Date.now()+3600000})).campaign;assert.equal(later.status,'scheduled');
 await call('/api/campaigns/'+later.id+'/cancel',admin.cookie,{expectedRevision:99},'POST',409);
 const cancelled=(await call('/api/campaigns/'+later.id+'/cancel',admin.cookie,{expectedRevision:later.revision})).campaign;assert.equal(cancelled.status,'cancelled');
 assert.equal((await call('/api/campaigns/'+later.id+'/cancel',admin.cookie,{expectedRevision:0})).campaign.status,'cancelled');
 await sleep(2500);assert.equal(one("SELECT count(*) n FROM messages WHERE client_ref LIKE 'campaign:%'").n,sent0);

 // cancelar una campaña en vuelo detiene lo que falta; lo ya enviado se conserva
 await call('/api/campaigns/settings/'+brandId,admin.cookie,{paceSeconds:60,expectedRevision:(await call('/api/campaigns/settings',admin.cookie)).settings.find(s=>s.brand_id===brandId).revision},'PATCH');
 await consent('carla','opted_in');await consent('dora','opted_in');await consent('beto','opted_in');
 const wide=(await call('/api/campaigns',admin.cookie,{...base,title:'Todos',requireConsent:false},'POST',201)).campaign;
 const pw=(await call('/api/campaigns/'+wide.id+'/preview',admin.cookie,{})).preview;assert.ok(pw.eligible>=2);
 await call('/api/campaigns/'+wide.id+'/schedule',admin.cookie,{expectedRevision:wide.revision,confirmAudience:pw.eligible});
 let live;for(let i=0;i<30&&!(live=(await call('/api/campaigns/'+wide.id,admin.cookie)).campaign).stats.sent;i++)await sleep(400);
 assert.ok(live.stats.sent>=1&&live.stats.queued>=1,'una enviada y otras en espera por el ritmo de 60 s');
 const stopped=(await call('/api/campaigns/'+wide.id+'/cancel',admin.cookie,{expectedRevision:live.revision})).campaign;
 assert.equal(stopped.status,'cancelled');assert.equal(stopped.stats.queued,0);assert.ok(stopped.stats.sent>=1);assert.ok(stopped.stats.skipped>=1);assert.ok(stopped.stats.skippedReasons.some(r=>r.reason==='campaign_cancelled'));

 // el listado y la persistencia
 const list=(await call('/api/campaigns',admin.cookie)).campaigns;assert.ok(list.length>=6);assert.ok(list.every(c=>typeof c.stats.recipients==='number'));
 assert.equal(one('PRAGMA user_version').user_version,35);
 assert.ok(one("SELECT count(*) n FROM audit WHERE action IN ('campaign.create','campaign.schedule','campaign.cancel','campaign.settings')").n>=6);
});
