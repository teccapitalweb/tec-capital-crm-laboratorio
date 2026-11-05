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
    return `<svg class="co-bars" viewBox="0 0 ${x} 40" preserveAspectRatio="none" role="img" aria-label="Código de barras de ejemplo" fill="currentColor">${out}</svg>`;
  }
  function html(o,{esc,icon}){
    const line=o.kind==='session'&&o.session?`Sesión ${o.session.number}. ${esc(o.session.title)}`:o.plan==='per_session'?'Plan por sesión · este pago cubre tu primera sesión':'';
    const until=new Date(o.expiresAt).toLocaleString('es-MX',{dateStyle:'medium',timeStyle:'short'});
    return `<div class="co">
      <div class="info-box co-sim"><strong>Simulación.</strong> No se cobra nada y no se guarda ninguna tarjeta. Así se verá el pago cuando haya una pasarela real.</div>
      <section class="co-summary" aria-label="Resumen del pedido">
        <span class="co-brand">${esc(o.brand)}</span>
        <h3>${esc(o.course)} · ${esc(o.edition)}</h3>
        ${line?`<p>${line}</p>`:''}
        <div class="co-amount">${esc(o.amountLabel)}</div>
        <small>${o.promotion?esc(o.promotion)+' · ':''}Referencia ${esc(o.reference)} · vigente hasta ${esc(until)}</small>
      </section>
      <div class="co-tabs" role="tablist" aria-label="Método de pago">
        <button type="button" role="tab" aria-selected="true" data-co-tab="card">${icon('credit-card')} Tarjeta</button>
        <button type="button" role="tab" aria-selected="false" data-co-tab="oxxo">${icon('store')} OXXO</button>
      </div>
      <div class="co-panel" data-co-panel="card" role="tabpanel">
        <label class="field">Nombre en la tarjeta<input id="co-name" autocomplete="off" maxlength="60" placeholder="Nombre y apellido"></label>
        <label class="field">Número de tarjeta<input id="co-number" inputmode="numeric" autocomplete="off" maxlength="19" placeholder="4242 4242 4242 4242"></label>
        <div class="co-row">
          <label class="field">Vence (MM/AA)<input id="co-exp" inputmode="numeric" autocomplete="off" maxlength="5" placeholder="12/34"></label>
          <label class="field">CVC<input id="co-cvc" inputmode="numeric" autocomplete="off" maxlength="3" placeholder="123"></label>
        </div>
        <div class="co-fill"><span>Tarjetas de prueba:</span><button type="button" class="btn" data-co-fill="ok">Una que aprueba</button><button type="button" class="btn" data-co-fill="declined">Una que rechaza</button></div>
        <div id="co-error" role="alert"></div>
        <button type="button" class="btn primary wide co-pay" data-action="pay-sim" data-id="${esc(o.id)}" data-method="card">${icon('lock')} Pagar ${esc(o.amountLabel)}</button>
      </div>
      <div class="co-panel" data-co-panel="oxxo" role="tabpanel" hidden>
        <div class="co-voucher">
          <small>Referencia de pago</small>
          <strong>${oxxoRef(o.id)}</strong>
          ${bars(oxxoRef(o.id))}
          <p>Paga ${esc(o.amountLabel)} en cualquier tienda OXXO antes del ${esc(until)}. En esta simulación no hay tienda: pulsa el botón para confirmar que ya pagaste.</p>
        </div>
        <button type="button" class="btn primary wide" data-action="pay-sim" data-id="${esc(o.id)}" data-method="oxxo">Simular que ya pagué en OXXO</button>
      </div>
      <button type="button" class="btn wide" data-action="close-modal">Enviaré mi comprobante por el chat</button>
      <p class="co-foot">Pasarela simulada del laboratorio. Los pagos reales llegarán cuando cada consultora conecte su cuenta.</p>
    </div>`;
  }
  const $=s=>document.querySelector(s);
  function validate(){
    const name=$('#co-name').value.trim(),num=digits($('#co-number').value),exp=$('#co-exp').value,cvc=digits($('#co-cvc').value);
    if(name.length<2)return {error:'Escribe el nombre que aparece en la tarjeta.',field:'#co-name'};
    if(!TEST[num])return {error:'Esto es una simulación: usa una tarjeta de prueba (por ejemplo 4242 4242 4242 4242) y no escribas una tarjeta real.',field:'#co-number'};
    const m=exp.match(/^(\d{2})\/(\d{2})$/);if(!m||+m[1]<1||+m[1]>12)return {error:'Escribe el vencimiento como MM/AA, por ejemplo 12/34.',field:'#co-exp'};
    if(cvc.length!==3)return {error:'El CVC tiene 3 números; en la simulación sirve cualquiera, por ejemplo 123.',field:'#co-cvc'};
    return {outcome:TEST[num]};
  }
  document.addEventListener('click',e=>{
    const tab=e.target.closest('[data-co-tab]');
    if(tab){const co=tab.closest('.co');co.querySelectorAll('[data-co-tab]').forEach(b=>b.setAttribute('aria-selected',String(b===tab)));co.querySelectorAll('[data-co-panel]').forEach(p=>{p.hidden=p.dataset.coPanel!==tab.dataset.coTab;});return;}
    const fill=e.target.closest('[data-co-fill]');
    if(fill){$('#co-name').value=$('#co-name').value||'Cliente de prueba';$('#co-number').value=fill.dataset.coFill==='declined'?'4000 0000 0000 0002':'4242 4242 4242 4242';$('#co-exp').value='12/34';$('#co-cvc').value='123';$('#co-error').innerHTML='';return;}
    const pay=e.target.closest('.co-pay');
    if(pay){
      const r=validate();
      if(r.error){e.stopImmediatePropagation();e.stopPropagation();e.preventDefault();const box=$('#co-error');box.textContent='';const msg=document.createElement('div');msg.className='form-error';msg.textContent=r.error;box.append(msg);$(r.field).focus();return;}
      pay.dataset.outcome=r.outcome;
    }
  },true);
  document.addEventListener('input',e=>{
    if(e.target.id==='co-number')e.target.value=groups(digits(e.target.value).slice(0,16),4);
    if(e.target.id==='co-exp'){const d=digits(e.target.value).slice(0,4);e.target.value=d.length>2?d.slice(0,2)+'/'+d.slice(2):d;}
    if(e.target.id==='co-cvc')e.target.value=digits(e.target.value).slice(0,3);
  });
  return {html};
})();
