// Pago simulado con aspecto de pasarela (docs/PLAN_PAGO_SIMULADO.md). Muestra cómo se verá el pago real cuando haya pasarela:
// resumen del pedido, tarjeta u OXXO. Es una SIMULACIÓN: nada se cobra, los datos de la tarjeta NO se envían ni se guardan
// (los campos no tienen "name" y sólo se leen aquí, en el navegador) y sólo se aceptan números de tarjeta de prueba.
// Al pagar se usa la misma acción de siempre (pay-sim → POST /api/payments/orders/:id/pay con método y resultado).
window.simCheckout=(()=>{
  const TEST={'4242424242424242':'approved','5555555555554444':'approved','4000000000000002':'declined'};
  const digits=s=>String(s||'').replace(/\D/g,'');
  const groups=(s,n)=>s.replace(new RegExp('(.{'+n+'})(?=.)','g'),'$1 ');
  // Referencia de OXXO y código de barras decorativos, derivados del pedido (siempre iguales para el mismo pedido).
  const oxxoRef=id=>groups(('97'+digits(id)+'7777777777777').slice(0,14),4);
  function bars(ref){
    const d=digits(ref).split('').map(Number);let x=0,out='';
    for(let i=0;i<46;i++){const w=1+((d[i%d.length]+i*3)%4),gap=1+((d[(i+5)%d.length]+i)%3);if(i%2===0)out+=`<rect x="${x}" y="0" width="${w}" height="40"/>`;x+=w+(i%2?gap:1);}
    return `<svg class="pg-bars" viewBox="0 0 ${x} 40" preserveAspectRatio="none" role="img" aria-label="Código de barras de ejemplo" fill="currentColor">${out}</svg>`;
  }
  // «¿Tienes un cupón?»: sólo si la marca ofrece alguno para escribir; si el cliente aplicó el suyo, puede quitarlo. Nunca manda un precio: el servidor recalcula.
  function couponBlock(o,{esc,icon,preview}){
    if(preview)return '';
    if(o.coupon?.removable)return `<div class="pg-coupon"><span>${icon('ticket-percent')} Cupón <strong>${esc(o.coupon.code)}</strong> aplicado (−${esc(o.coupon.discountLabel)})</span><button type="button" class="btn" data-action="pay-coupon-remove" data-id="${esc(o.id)}">Quitar</button></div>`;
    if(o.couponEntry)return `<details class="pg-coupon pg-coupon-entry"><summary>${icon('ticket-percent')} ¿Tienes un cupón?</summary><div class="pg-coupon-row"><input id="pg-coupon" maxlength="24" autocomplete="off" autocapitalize="characters" placeholder="Escribe tu código" aria-label="Código de cupón"><button type="button" class="btn" data-action="pay-coupon-apply" data-id="${esc(o.id)}">Aplicar</button></div><p id="pg-coupon-msg" role="alert"></p></details>`;
    return '';
  }
  function html(o,{esc,icon,preview=false}){
    const line=o.kind==='session'&&o.session?`Sesión ${o.session.number}. ${esc(o.session.title)}`:o.plan==='per_session'?'Plan por sesión · este pago cubre tu primera sesión':'';
    const until=new Date(o.expiresAt).toLocaleString('es-MX',{dateStyle:'medium',timeStyle:'short'});
    return `<div class="pg">
      <div class="info-box pg-sim">${preview?'<strong>Vista previa para el equipo.</strong> Así verá el cliente su pantalla de pago. Aquí los botones de pagar no hacen nada.':'<strong>Simulación.</strong> No se cobra nada y no se guarda ninguna tarjeta. Así se verá el pago cuando haya una pasarela real.'}</div>
      <section class="pg-summary" aria-label="Resumen del pedido">
        <span class="pg-brand">${esc(o.brand)}</span>
        <h3>${esc(o.course)} · ${esc(o.edition)}</h3>
        ${line?`<p>${line}</p>`:''}
        <div class="pg-amount">${esc(o.amountLabel)}</div>
        <small>${o.promotion?esc(o.promotion)+' · ':''}${o.coupon?'Cupón '+esc(o.coupon.code)+' (−'+esc(o.coupon.discountLabel)+') · ':''}Referencia ${esc(o.reference)} · vigente hasta ${esc(until)}</small>
      </section>
      ${couponBlock(o,{esc,icon,preview})}
      <div class="pg-tabs" role="tablist" aria-label="Método de pago">
        <button type="button" role="tab" aria-selected="true" data-pg-tab="card">${icon('credit-card')} Tarjeta</button>
        <button type="button" role="tab" aria-selected="false" data-pg-tab="oxxo">${icon('store')} OXXO</button>
      </div>
      <div class="pg-panel" data-pg-panel="card" role="tabpanel">
        <label class="field">Nombre en la tarjeta<input id="pg-name" autocomplete="off" maxlength="60" placeholder="Nombre y apellido"></label>
        <label class="field">Número de tarjeta<input id="pg-number" inputmode="numeric" autocomplete="off" maxlength="19" placeholder="4242 4242 4242 4242"></label>
        <div class="pg-row">
          <label class="field">Vence (MM/AA)<input id="pg-exp" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="12/34"></label>
          <label class="field">CVC<input id="pg-cvc" inputmode="numeric" autocomplete="off" maxlength="3" placeholder="123"></label>
        </div>
        <div class="pg-fill"><span>Tarjetas de prueba:</span><button type="button" class="btn" data-pg-fill="ok">Una que aprueba</button><button type="button" class="btn" data-pg-fill="declined">Una que rechaza</button></div>
        <div id="pg-error" role="alert"></div>
        <button type="button" class="btn primary wide ${preview?'':'pg-pay'}" ${preview?'disabled':`data-action="pay-sim" data-id="${esc(o.id)}" data-method="card"`}>${icon('lock')} Pagar ${esc(o.amountLabel)}</button>
      </div>
      <div class="pg-panel" data-pg-panel="oxxo" role="tabpanel" hidden>
        <div class="pg-voucher">
          <small>Referencia de pago</small>
          <strong>${oxxoRef(o.id)}</strong>
          ${bars(oxxoRef(o.id))}
          <p>Paga ${esc(o.amountLabel)} en cualquier tienda OXXO antes del ${esc(until)}. En esta simulación no hay tienda: pulsa el botón para confirmar que ya pagaste.</p>
        </div>
        <button type="button" class="btn primary wide" ${preview?'disabled':`data-action="pay-sim" data-id="${esc(o.id)}" data-method="oxxo"`}>Simular que ya pagué en OXXO</button>
      </div>
      <button type="button" class="btn wide" data-action="close-modal">Enviaré mi comprobante por el chat</button>
      <p class="pg-foot">Pasarela simulada del laboratorio. Los pagos reales llegarán cuando cada consultora conecte su cuenta.</p>
    </div>`;
  }
  const $=s=>document.querySelector(s);
  function validate(){
    const name=$('#pg-name').value.trim(),num=digits($('#pg-number').value),exp=$('#pg-exp').value,cvc=digits($('#pg-cvc').value);
    if(name.length<2)return {error:'Escribe el nombre que aparece en la tarjeta.',field:'#pg-name'};
    if(!TEST[num])return {error:'Esto es una simulación: usa una tarjeta de prueba (por ejemplo 4242 4242 4242 4242) y no escribas una tarjeta real.',field:'#pg-number'};
    const m=exp.match(/^(\d{2})\/(\d{2})$/);if(!m||+m[1]<1||+m[1]>12)return {error:'Escribe el vencimiento como MM/AA, por ejemplo 12/34.',field:'#pg-exp'};
    if(cvc.length!==3)return {error:'El CVC tiene 3 números; en la simulación sirve cualquiera, por ejemplo 123.',field:'#pg-cvc'};
    return {outcome:TEST[num]};
  }
  document.addEventListener('click',e=>{
    const tab=e.target.closest('[data-pg-tab]');
    if(tab){const co=tab.closest('.pg');co.querySelectorAll('[data-pg-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===tab)));co.querySelectorAll('[data-pg-panel]').forEach(p=>{p.hidden=p.dataset.pgPanel!==tab.dataset.pgTab;});return;}
    const fill=e.target.closest('[data-pg-fill]');
    if(fill){$('#pg-name').value=$('#pg-name').value||'Cliente de prueba';$('#pg-number').value=fill.dataset.pgFill==='declined'?'4000 0000 0000 0002':'4242 4242 4242 4242';$('#pg-exp').value='12/34';$('#pg-cvc').value='123';$('#pg-error').innerHTML='';return;}
    const pay=e.target.closest('.pg-pay');
    if(pay){
      const r=validate();
      if(r.error){e.stopImmediatePropagation();e.stopPropagation();e.preventDefault();const box=$('#pg-error');box.textContent='';const msg=document.createElement('div');msg.className='form-error';msg.textContent=r.error;box.append(msg);$(r.field).focus();return;}
      pay.dataset.outcome=r.outcome;
    }
  },true);
  document.addEventListener('input',e=>{
    if(e.target.id==='pg-number')e.target.value=groups(digits(e.target.value).slice(0,16),4);
    if(e.target.id==='pg-exp'){const d=digits(e.target.value).slice(0,4);e.target.value=d.length>2?d.slice(0,2)+'/'+d.slice(2):d;}
    if(e.target.id==='pg-cvc')e.target.value=digits(e.target.value).slice(0,3);
  });
  return {html};
})();
