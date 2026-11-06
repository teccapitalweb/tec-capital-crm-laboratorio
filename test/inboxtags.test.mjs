import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

test('etiquetas en la bandeja por API: etiquetas por hilo, filtro por etiqueta con alcance por marca, parámetro inválido ignorado y nada de esto llega al cliente',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'crm-inboxtags-')),code=randomUUID(),password='Password-tags-2026!';let logs='';
  const server=spawn(process.execPath,['server/index.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',DATA_DIR:dir,ADMIN_INVITE_CODE:code,APP_ORIGIN:'',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
  const origin=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(logs)),10000);server.stderr.on('data',b=>logs+=b);server.stdout.on('data',b=>{const m=String(b).match(/http:\/\/127.0.0.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});server.once('exit',()=>{clearTimeout(timer);reject(Error(logs));});});
  t.after(async()=>{if(server.exitCode===null)await new Promise(r=>{server.once('exit',r);server.kill();});await rm(dir,{recursive:true,force:true});});
  async function call(path,cookie='',body,method=body===undefined?'GET':'POST',expected=200){const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,expected,path+': '+JSON.stringify(result));return {...result,cookie:r.headers.get('set-cookie')?.split(';')[0]};}
  const db=()=>new DatabaseSync(join(dir,'laboratorio.sqlite'),{timeout:5000}),one=(sql,...a)=>{const d=db();try{return d.prepare(sql).get(...a);}finally{d.close();}};
  assert.equal((await fetch(origin+'/inboxtags.js')).status,200);

  const admin=await call('/api/auth/register','',{username:'admin',name:'Administración',password,inviteCode:code});
  async function member(username,name,brandIds){const u=await call('/api/auth/register','',{username,name,password});const inv=await call('/api/team/invites',admin.cookie,{username,brandIds},'POST',201);await call('/api/team/accept',u.cookie,{token:inv.token});return u;}
  const vende=await member('vende','Vera Vendedora',['globalvet']),otra=await member('otra','Omar Otro',['odonteck']);
  const ana=await call('/api/auth/register','',{username:'ana',name:'Ana Pérez',password}),beto=await call('/api/auth/register','',{username:'beto',name:'Beto Ruiz',password}),carla=await call('/api/auth/register','',{username:'carla',name:'Carla Soto',password});
  const convAna=(await call('/api/conversations',ana.cookie,{courseId:'aves',channel:'whatsapp'})).conversation;
  const odonCourse=one("SELECT id FROM courses WHERE brand_id='odonteck' LIMIT 1").id,convBeto=(await call('/api/conversations',beto.cookie,{courseId:odonCourse,channel:'whatsapp'})).conversation;
  const convCarla=(await call('/api/conversations',carla.cookie,{courseId:'aves',channel:'instagram'})).conversation;

  const staffList=async(cookie,q='')=>(await call('/api/conversations'+q,cookie)).conversations;
  const mine=await staffList(vende.cookie);const anaRow=mine.find(c=>c.id===convAna.id);
  assert.ok(anaRow.contact_id,'el equipo recibe el contacto del hilo');assert.deepEqual(anaRow.tags,[]);
  const carlaRow=mine.find(c=>c.id===convCarla.id);

  // etiquetas por marca y aplicadas a dos contactos de GlobalVet y uno de OdonTeck
  const vip=(await call('/api/crm/tags',vende.cookie,{brandId:'globalvet',name:'VIP',color:'amber'},'POST',201)).tag,beca=(await call('/api/crm/tags',vende.cookie,{brandId:'globalvet',name:'Pidió beca'},'POST',201)).tag;
  const odonTag=(await call('/api/crm/tags',otra.cookie,{brandId:'odonteck',name:'Consultorio propio'},'POST',201)).tag;
  await call('/api/crm/contacts/'+anaRow.contact_id+'/tags',vende.cookie,{tagIds:[vip.id,beca.id]},'PUT');await call('/api/crm/contacts/'+carlaRow.contact_id+'/tags',vende.cookie,{tagIds:[beca.id]},'PUT');
  const betoRow=(await staffList(otra.cookie)).find(c=>c.id===convBeto.id);await call('/api/crm/contacts/'+betoRow.contact_id+'/tags',otra.cookie,{tagIds:[odonTag.id]},'PUT');

  // cada hilo trae las etiquetas de su contacto
  const after=await staffList(vende.cookie);
  assert.deepEqual(after.find(c=>c.id===convAna.id).tags.map(t=>t.name).sort(),['Pidió beca','VIP']);assert.equal(after.find(c=>c.id===convAna.id).tags.find(t=>t.name==='VIP').color,'amber');
  assert.deepEqual(after.find(c=>c.id===convCarla.id).tags.map(t=>t.name),['Pidió beca']);assert.equal(after.some(c=>c.id===convBeto.id),false,'Vera no ve hilos de otra marca');

  // filtro por etiqueta
  assert.deepEqual((await staffList(vende.cookie,'?tag='+vip.id)).map(c=>c.id),[convAna.id]);
  assert.deepEqual((await staffList(vende.cookie,'?tag='+beca.id)).map(c=>c.id).sort(),[convAna.id,convCarla.id].sort());
  assert.deepEqual((await staffList(vende.cookie,'?tag='+beca.id+'&channel=instagram')).map(c=>c.id),[convCarla.id],'se combina con los demás filtros');
  assert.deepEqual((await staffList(vende.cookie,'?tag='+odonTag.id)),[],'una etiqueta de otra marca no abre hilos ajenos');
  assert.deepEqual((await staffList(otra.cookie,'?tag='+beca.id)),[],'ni Omar ve los de GlobalVet por etiqueta');
  assert.deepEqual((await staffList(admin.cookie,'?tag='+odonTag.id)).map(c=>c.id),[convBeto.id]);assert.equal((await staffList(admin.cookie)).length,3);
  assert.equal((await staffList(vende.cookie,'?tag=no-es-un-id')).length,2,'un valor inválido se ignora');
  assert.equal((await staffList(vende.cookie,'?tag=')).length,2);

  // quitar la etiqueta saca el hilo del filtro
  await call('/api/crm/contacts/'+carlaRow.contact_id+'/tags',vende.cookie,{tagIds:[]},'PUT');
  assert.deepEqual((await staffList(vende.cookie,'?tag='+beca.id)).map(c=>c.id),[convAna.id]);assert.deepEqual((await staffList(vende.cookie)).find(c=>c.id===convCarla.id).tags,[]);

  // el detalle también las trae
  assert.deepEqual((await call('/api/conversations/'+convAna.id,vende.cookie)).conversation.tags.map(t=>t.name).sort(),['Pidió beca','VIP']);

  // el cliente no recibe etiquetas ni el contacto interno, y el filtro no le sirve
  const own=(await call('/api/conversations?tag='+vip.id,ana.cookie)).conversations;assert.equal(own.length,1);assert.equal('tags' in own[0],false);assert.equal('contact_id' in own[0],false);
  assert.equal('tags' in (await call('/api/conversations/'+convAna.id,ana.cookie)).conversation,false);
  assert.equal(one('PRAGMA user_version').user_version,29,'sin migración nueva');
});
