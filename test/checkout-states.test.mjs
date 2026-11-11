import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

// public/checkout.js es un script de navegador (window.simCheckout). Aquí se carga con un documento mínimo para probar el HTML de los
// estados de la pasarela de prueba: procesando, aprobado (con comprobante de ejemplo), rechazado y error.
async function load(){
 const listeners={};const ctx={window:{},document:{addEventListener:(type,fn)=>{(listeners[type]||=[]).push(fn);},querySelector:()=>null},Date,String,Number,RegExp,Math,JSON};
 vm.createContext(ctx);vm.runInContext(await readFile('public/checkout.js','utf8'),ctx);
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),icon=n=>`<i data-lucide="${n}"></i>`;
 return {sc:ctx.window.simCheckout,esc,icon};
}
const order={id:'1afa5c80-3856-410e-95c2-dda4300a3140',reference:'TC-F53D5D',course:'Plan <b>sanitario</b> para aves',edition:'Edición "general"',amountLabel:'$379.00',brand:'GlobalVet'};

test('pasarela de prueba: estados de procesando, aprobado con comprobante de ejemplo, rechazado y error',async()=>{
 const {sc,esc,icon}=await load();
 assert.deepEqual(Object.keys(sc).sort(),['failed','html','processing','result']);
 const p=sc.processing({esc,icon});assert.match(p,/Procesando tu pago/);assert.match(p,/role="status"/);assert.match(p,/no se cobra nada/);

 const at=Date.UTC(2026,10,11,17,16);
 const ok=sc.result(order,{status:'paid',method:'card',last4:'4242',esc,icon,at});
 assert.match(ok,/Pago aprobado/);assert.match(ok,/data-action="pay-done"/);assert.match(ok,/Tarjeta de prueba ···· 4242/);assert.match(ok,/TC-F53D5D/);assert.match(ok,/\$379\.00/);
 assert.match(ok,/Autorización de ejemplo<\/dt><dd>SIM-\d{6}/);assert.match(ok,/no es un documento fiscal ni prueba de un cobro real/,'el comprobante dice que es una simulación');
 assert.ok(ok.includes('Plan &lt;b&gt;sanitario&lt;/b&gt; para aves · Edición &quot;general&quot;'),'los datos del pedido salen escapados');assert.doesNotMatch(ok,/<b>sanitario/);
 assert.doesNotMatch(ok,/4242 ?4242|\d{12,}/,'nunca aparece un número de tarjeta completo');
 const oxxo=sc.result(order,{status:'paid',method:'oxxo',esc,icon,at});assert.match(oxxo,/OXXO \(simulado\)/);assert.doesNotMatch(oxxo,/····/);

 const bad=sc.result(order,{status:'pending',method:'card',last4:'0002',esc,icon,at});
 assert.match(bad,/Pago rechazado/);assert.match(bad,/No se hizo ningún cargo/);assert.match(bad,/sigue vigente/);assert.match(bad,/data-action="pay-open" data-id="1afa5c80-3856-410e-95c2-dda4300a3140"/);assert.doesNotMatch(bad,/Pago aprobado|pg-receipt/);

 const err=sc.failed('El pedido <venció>',{esc,icon,id:order.id});
 assert.match(err,/No se pudo completar el pago/);assert.ok(err.includes('El pedido &lt;venció&gt;'));assert.match(err,/data-action="pay-open"/);assert.match(err,/data-action="pay-done"/);
 assert.doesNotMatch(sc.failed('x',{esc,icon}),/data-action="pay-open"/,'sin pedido no se ofrece volver a pagar');
});
