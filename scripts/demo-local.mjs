#!/usr/bin/env node
// Base de pruebas local del CRM (docs/BASE_DE_PRUEBAS.md). Crea, en tu computadora, una base nueva con un usuario de cada tipo
// y datos de ejemplo, enciende las funciones de una marca de práctica y arranca el servidor para probar todo.
//   npm run demo          crea la base la primera vez y arranca (las siguientes veces sólo arranca)
//   npm run demo:reset    borra la base de pruebas y la crea de nuevo
// Todo se hace por la API real del CRM (como lo haría una persona), nunca contra producción. Las contraseñas se generan al azar,
// se muestran aquí y se guardan en data-demo/CREDENCIALES.txt, que Git ignora. Variables: DEMO_PORT (3300), DEMO_DIR (data-demo).
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=resolve(process.env.DEMO_DIR||resolve(root,'data-demo')),port=Number(process.env.DEMO_PORT||3300),creds=resolve(dir,'CREDENCIALES.txt');
const reset=process.argv.includes('--reset');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const password=()=>randomBytes(9).toString('base64url');

if(reset&&existsSync(dir)){rmSync(dir,{recursive:true,force:true});console.log('Base de pruebas anterior eliminada.');}
const fresh=!existsSync(creds);
mkdirSync(dir,{recursive:true});
const inviteCode=randomBytes(18).toString('base64url');

console.log(fresh?'Creando la base de pruebas…':'Arrancando la base de pruebas existente…');
const server=spawn(process.execPath,['server/index.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:dir,ADMIN_INVITE_CODE:inviteCode,APP_ORIGIN:'',NODE_ENV:'development',BACKUP_INTERVAL_HOURS:'0'},stdio:['ignore','pipe','pipe']});
let log='';
const origin=await new Promise((resolveOrigin,reject)=>{
  const timer=setTimeout(()=>reject(Error('El servidor no arrancó en 20 s.\n'+log)),20000);
  server.stderr.on('data',b=>{log+=b;process.stderr.write(b);});
  server.stdout.on('data',b=>{log+=b;const m=String(b).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolveOrigin(m[0]);}});
  server.once('exit',code=>{clearTimeout(timer);reject(Error('El servidor se cerró (código '+code+'). ¿El puerto '+port+' está ocupado? Prueba con DEMO_PORT=3310.\n'+log));});
}).catch(e=>{console.error(e.message);process.exit(1);});
const stop=()=>{if(server.exitCode===null)server.kill();};
process.on('SIGINT',()=>{stop();process.exit(0);});process.on('SIGTERM',()=>{stop();process.exit(0);});process.on('exit',stop);
server.once('exit',code=>{console.log('\nServidor detenido.');process.exit(code||0);});

async function call(path,cookie='',body,method=body===undefined?'GET':'POST',okStatuses=[200,201]){
  const r=await fetch(origin+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await r.json().catch(()=>({}));
  if(!okStatuses.includes(r.status))throw Error(`${method} ${path} → ${r.status}: ${data.error||JSON.stringify(data)}`);
  return {...data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
}

async function seed(){
  const accounts=[];const add=(username,name,role,note)=>{const a={username,name,role,note,password:password()};accounts.push(a);return a;};
  const A=add('admin.demo','Dirección demo','Administración','Todo: catálogo, Operación, Finanzas, Campañas, Equipo y «Ver a» en Mis resultados');
  const S1=add('asesor.demo','Asesora GlobalVet demo','Asesor (GlobalVet)','Conversaciones, Contactos, Oportunidades, respuestas rápidas y Mis resultados de GlobalVet');
  const S2=add('asesor.odon','Asesor OdonTeck demo','Asesor (OdonTeck)','Comprobar que NO ve nada de GlobalVet (alcance por marca)');
  const FIN=add('contadora.demo','Contadora demo','Asesor + función de contadora','Finanzas de todas las marcas (libro, comisiones, liquidaciones)');
  const COO=add('coordinador.demo','Coordinador demo','Asesor + responsable de apertura','Mis resultados → Mis aperturas y avisos; coordina la apertura del curso de aves');
  const C1=add('cliente.demo','Cliente demo uno','Cliente','Escribe por WhatsApp; entra por «Cliente» o por la dirección principal');
  const C2=add('cliente.demo2','Cliente demo dos','Cliente','Escribe por Instagram a OdonTeck');
  const C3=add('cliente.demo3','Cliente demo tres','Cliente','Escribe por Facebook a GlobalVet');

  // cuentas: primero todas como personas normales; luego administración invita al equipo
  const sessions={};
  sessions[A.username]=await call('/api/auth/register','',{username:A.username,name:A.name,password:A.password,inviteCode});
  for(const x of [S1,S2,FIN,COO,C1,C2,C3])sessions[x.username]=await call('/api/auth/register','',{username:x.username,name:x.name,password:x.password});
  const admin=sessions[A.username];
  const brands=(await call('/api/bootstrap',admin.cookie)).brands.map(b=>b.id);
  const team=[[S1,['globalvet']],[S2,['odonteck']],[FIN,brands],[COO,['globalvet']]];
  for(const [x,brandIds] of team){const inv=await call('/api/team/invites',admin.cookie,{username:x.username,brandIds});await call('/api/team/accept',sessions[x.username].cookie,{token:inv.token});}
  const id=x=>sessions[x.username].user.id;
  await call('/api/finance/access',admin.cookie,{userId:id(FIN),enabled:true,canMarkPaid:true},'PUT');

  // funciones de la marca de práctica (GlobalVet): todo encendido para poder probarlo
  const on=(path,body)=>call(path,admin.cookie,{...body,expectedRevision:0},'PATCH');
  await on('/api/automation/brands/globalvet',{enabled:true});
  await on('/api/channel/brands/globalvet',{enabled:true});
  await on('/api/payments/brands/globalvet',{enabled:true,linkHours:48});
  await on('/api/coordination/brands/globalvet',{enabled:true,autoOpen:true,reminderHours:24});
  await on('/api/certificates/brands/globalvet',{autoIssue:true});
  await on('/api/campaigns/settings/globalvet',{enabled:true});
  await call('/api/finance/rules',admin.cookie,{role:'consultora',percentBp:2000,expectedRevision:0},'PUT');
  await call('/api/finance/rules',admin.cookie,{role:'vendedor',percentBp:500,expectedRevision:0},'PUT');
  const edition=(await call('/api/coordination/editions/edition-aves',admin.cookie)).edition;
  await call('/api/coordination/editions/edition-aves',admin.cookie,{coordinatorId:id(COO),minStudents:3,expectedRevision:edition?.run_revision??1},'PATCH');

  // conversaciones de clientes
  const courses=(await call('/api/bootstrap',admin.cookie)).courses;const courseOf=b=>courses.find(c=>c.brand_id===b).id;
  const talk=async(x,courseId,channel,text)=>{const c=(await call('/api/conversations',sessions[x.username].cookie,{courseId,channel})).conversation;await call('/api/conversations/'+c.id+'/messages',sessions[x.username].cookie,{text,clientRef:randomBytes(8).toString('hex')+'-demo'});return c;};
  await talk(C1,'aves','whatsapp','Hola, me interesa el curso. ¿Cuánto cuesta y cuándo empieza?');
  await talk(C2,courseOf('odonteck'),'instagram','Buenas tardes, ¿me comparten el temario por favor?');
  await talk(C3,'aves','facebook','Hola, quiero inscribirme. ¿Cómo pago?');
  await sleep(2500);

  // etiquetas y respuestas rápidas
  const list=(await call('/api/conversations',sessions[S1.username].cookie)).conversations;
  const tagVip=(await call('/api/crm/tags',sessions[S1.username].cookie,{brandId:'globalvet',name:'VIP',color:'amber'})).tag,tagBeca=(await call('/api/crm/tags',sessions[S1.username].cookie,{brandId:'globalvet',name:'Pidió beca',color:'blue'})).tag;
  if(list[0]?.contact_id)await call('/api/crm/contacts/'+list[0].contact_id+'/tags',sessions[S1.username].cookie,{tagIds:[tagVip.id,tagBeca.id]},'PUT');
  if(list[1]?.contact_id)await call('/api/crm/contacts/'+list[1].contact_id+'/tags',sessions[S1.username].cookie,{tagIds:[tagBeca.id]},'PUT');
  await call('/api/quick-replies',sessions[S1.username].cookie,{shortcut:'gracias',title:'Agradecer y presentarme',body:'Hola {{nombre}}, gracias por escribir sobre {{curso}}. Soy {{asesor}} de {{marca}}.'});
  await call('/api/quick-replies',admin.cookie,{scope:'brand',brandId:'globalvet',shortcut:'bienvenida',title:'Bienvenida de la marca',body:'Bienvenido a {{marca}}, {{nombre}}. ¿Te cuento fechas y formas de pago?'});

  // clientes ficticios con los nueve perfiles del simulador (curioso, molesto, pagador, baja, silencio…)
  const run=(await call('/api/simulator/runs',admin.cookie,{count:9,pace:'rapida',brandIds:'all'})).run;
  for(let i=0;i<240;i++){const r=(await call('/api/simulator/runs/'+run.id,admin.cookie)).run;if(r.stats.byState.active===0)break;await sleep(500);}

  const lines=[
    'BASE DE PRUEBAS TEC CAPITAL · '+new Date().toLocaleString('es-MX'),
    'Sólo para tu computadora. Datos ficticios. No uses estas contraseñas en ningún otro sitio.',
    '',
    'Dirección del CRM del equipo : '+origin.replace('127.0.0.1','localhost')+'/crm',
    'Dirección de los clientes    : '+origin.replace('127.0.0.1','localhost')+'/',
    '',
    ...accounts.flatMap(a=>[`${a.role}`,`   usuario    : ${a.username}`,`   contraseña : ${a.password}`,`   para probar: ${a.note}`,'']),
    'Marca de práctica con todo encendido: GlobalVet. Los clientes «· demo» los creó el simulador.',
    'Para borrar todo y empezar de cero: npm run demo:reset',
  ];
  writeFileSync(creds,lines.join('\n')+'\n',{mode:0o600});
}

try{if(fresh)await seed();}catch(e){console.error('\nNo se pudo preparar la base de pruebas:\n'+e.message);stop();process.exit(1);}
console.log('\n'+readFileSync(creds,'utf8'));
console.log('Listo. El servidor sigue corriendo; ciérralo con Ctrl+C.\n');
