// Constructor del flujo de bienvenida (docs/PLAN_FLUJO_BIENVENIDA.md). Operación → Ventas y cobro → Flujo de bienvenida.
// Cada marca arma su saludo y su menú con botones; a la derecha se prueba como lo vería la persona. Lo escrito vive en un
// borrador en memoria hasta pulsar «Guardar»: agregar o quitar pasos no pierde lo que ya se tecleó.
window.createFlowsUI=function({state,api,esc,icon,toast}){
  let flows=null,actions={},limits={steps:10,buttons:3,label:20,text:900},brand=null,draft=null,dirty=false,sim=null;
  const $$=s=>[...document.querySelectorAll(s)];
  const clone=v=>JSON.parse(JSON.stringify(v));
  const current=()=>flows?.find(f=>f.brandId===brand)||flows?.[0]||null;
  const newId=()=>'p'+Math.random().toString(36).slice(2,8);
  const startDraft=f=>{draft=f?{enabled:f.enabled,withFlyer:f.withFlyer,steps:clone(f.steps)}:null;dirty=false;sim=null;};
  async function load(){const r=await api('/api/flows');flows=r.flows;actions=r.actions;limits=r.limits;if(!brand||!flows.some(f=>f.brandId===brand))brand=(state.brand&&state.brand!=='all'&&flows.some(f=>f.brandId===state.brand)?state.brand:flows[0]?.brandId)||null;if(!draft)startDraft(current());}   // el borrador (y la vista previa) sobreviven a cada redibujo; sólo se reinician al cambiar de marca, guardar o descartar
  function setBrand(id){if(dirty&&!confirm('Hay cambios sin guardar en este flujo. ¿Cambiar de marca y descartarlos?'))return;brand=id;startDraft(current());}
  const touch=()=>{dirty=true;const c=document.querySelector('#fl-dirty');if(c)c.hidden=false;};
  // Lee lo tecleado en la pantalla y lo deja en el borrador (antes de cualquier acción que vuelva a dibujar).
  function collect(){
    if(!draft||!document.querySelector('#fl-builder'))return;
    for(const el of $$('#fl-builder .fl-step')){const step=draft.steps.find(s=>s.id===el.dataset.step);if(!step)continue;
      step.text=el.querySelector('.fl-text').value;
      step.buttons=[...el.querySelectorAll('.fl-button')].map(b=>({label:b.querySelector('.fl-label').value,go:b.querySelector('.fl-go').value}));}
    draft.enabled=document.querySelector('#fl-enabled')?.checked??draft.enabled;draft.withFlyer=document.querySelector('#fl-flyer')?.checked??draft.withFlyer;
  }
  const sample=()=>{const f=current(),course=(state.courses||[]).find(c=>c.brand_id===brand);return {nombre:'María',curso:course?.title||'el curso',edicion:'Edición general',marca:f?.brandName||''};};
  const fill=text=>{const v=sample();return String(text||'').replace(/\{\{\s*nombre\s*\}\}/gi,v.nombre).replace(/\{\{\s*curso\s*\}\}/gi,v.curso).replace(/\{\{\s*edici[oó]n\s*\}\}/gi,v.edicion).replace(/\{\{\s*marca\s*\}\}/gi,v.marca);};
  const stepName=(s,i)=>i===0?'Saludo':'Paso '+(i+1);
  const SIM_NOTE={price:'El asistente manda el precio vigente del curso.',syllabus:'El asistente manda el temario del curso.',schedule:'El asistente manda las fechas, el horario y el docente.',enroll:'Se registra su interés: si la venta de prueba está activa recibe su enlace de pago; si no, pasa con una persona.',human:'La conversación pasa con una persona del equipo.'};

  function stepCard(s,i){
    const goOptions=sel=>'<optgroup label="El asistente responde">'+Object.entries(actions).map(([k,l])=>'<option value="action:'+k+'"'+(sel==='action:'+k?' selected':'')+'>'+esc(l)+'</option>').join('')+'</optgroup><optgroup label="Lleva a otro paso">'+draft.steps.map((t,j)=>t.id===s.id?'':'<option value="step:'+t.id+'"'+(sel==='step:'+t.id?' selected':'')+'>'+esc(stepName(t,j))+(t.text?' · '+esc(t.text.slice(0,28))+(t.text.length>28?'…':''):'')+'</option>').join('')+'</optgroup>';
    return '<article class="fl-step" data-step="'+esc(s.id)+'"><div class="fl-step-top"><span class="fl-step-n">'+(i+1)+'</span><strong>'+esc(stepName(s,i))+'</strong>'+(i===0?'<small>Lo primero que recibe quien escribe</small>':'<button type="button" class="btn fl-quiet" data-action="fl-del-step" data-id="'+esc(s.id)+'">'+icon('trash-2')+' Quitar paso</button>')+'</div>'
      +'<label class="field">Mensaje<textarea class="fl-text" rows="3" maxlength="'+limits.text+'" placeholder="Escribe lo que dirá el asistente en este paso">'+esc(s.text)+'</textarea></label>'
      +'<div class="fl-buttons">'+s.buttons.map((b,j)=>'<div class="fl-button"><label class="field">Botón '+(j+1)+'<input class="fl-label" maxlength="'+limits.label+'" value="'+esc(b.label)+'" placeholder="Texto del botón"></label><label class="field">Al pulsarlo<select class="fl-go">'+goOptions(b.go)+'</select></label><button type="button" class="icon-btn" data-action="fl-del-btn" data-id="'+esc(s.id)+'" data-index="'+j+'" aria-label="Quitar botón '+(j+1)+'">'+icon('x')+'</button></div>').join('')+'</div>'
      +(s.buttons.length<limits.buttons?'<button type="button" class="btn fl-quiet" data-action="fl-add-btn" data-id="'+esc(s.id)+'">'+icon('plus')+' Agregar botón</button>':'<p class="crm-hint">WhatsApp admite hasta '+limits.buttons+' botones por mensaje. Para más opciones, usa un botón que lleve a otro paso.</p>')
      +'</article>';
  }
  function preview(){
    if(!sim)sim={step:draft.steps[0]?.id,log:[]};
    const step=draft.steps.find(s=>s.id===sim.step)||draft.steps[0],done=sim.ended;
    const bubbles=[{who:'in',text:'Hola'},{who:'out',text:fill(draft.steps[0]?.text),flyer:draft.withFlyer},...sim.log];
    return '<aside class="fl-preview" aria-label="Vista previa del flujo"><div class="fl-phone"><div class="fl-phone-top"><span class="avatar">'+esc((current()?.brandName||'M').slice(0,1))+'</span><div><strong>'+esc(current()?.brandName||'')+'</strong><small>Vista previa · no se envía nada</small></div></div><div class="fl-chat">'
      +bubbles.map(b=>b.who==='note'?'<p class="fl-note">'+icon('sparkles')+' '+esc(b.text)+'</p>':'<div class="fl-bubble '+b.who+'">'+(b.flyer?'<span class="fl-flyer">'+icon('image')+' Ficha del curso</span>':'')+esc(b.text)+'</div>').join('')
      +(done?'<p class="fl-note">'+icon('flag')+' Aquí termina el recorrido guiado.</p>':step&&step.buttons.length?'<div class="fl-options">'+step.buttons.map((b,j)=>'<button type="button" class="fl-option" data-action="fl-press" data-index="'+j+'">'+esc(b.label||'(sin texto)')+'</button>').join('')+'</div>':'<p class="fl-note">Este paso no tiene botones: la persona sigue escribiendo y contesta el asistente.</p>')
      +'</div><div class="fl-phone-bottom"><button type="button" class="btn fl-quiet" data-action="fl-restart">'+icon('rotate-ccw')+' Empezar de nuevo</button></div></div><p class="crm-hint">Pulsa los botones para recorrer el flujo como lo vería la persona. Si escribe otra cosa, contesta el asistente de siempre.</p></aside>';
  }
  function html(){
    if(!flows)return '<div class="loading-message">Cargando…</div>';
    const f=current();if(!f||!draft)return '<div class="info-box">No tienes marcas a tu cargo.</div>';
    return '<div class="crm-toolbar"><p>El flujo de bienvenida es el recorrido guiado que recibe quien escribe por primera vez: un saludo y un menú con botones que lo llevan al temario, al precio, a las fechas o a inscribirse. Se arma aquí, sin código. Si la persona escribe otra cosa, contesta el asistente de siempre.</p></div>'
      +'<div class="fl-bar"><label class="field">Marca<select id="fl-brand">'+flows.map(x=>'<option value="'+esc(x.brandId)+'"'+(x.brandId===brand?' selected':'')+'>'+esc(x.brandName)+(x.enabled?' · encendido':'')+'</option>').join('')+'</select></label>'
      +'<span class="ops-chip '+(f.enabled?'ok':'')+'">'+(f.enabled?'Encendido':'Apagado')+'</span>'+(f.isDefault?'<span class="ops-chip">Flujo sugerido, sin guardar</span>':'')+'<span class="ops-chip warn" id="fl-dirty"'+(dirty?'':' hidden')+'>Cambios sin guardar</span></div>'
      +'<div class="fl-layout"><section class="fl-steps" id="fl-builder">'+draft.steps.map(stepCard).join('')
      +(draft.steps.length<limits.steps?'<button type="button" class="btn fl-add" data-action="fl-add-step">'+icon('plus')+' Agregar paso</button>':'')
      +'<div class="fl-settings"><label class="fl-check"><input type="checkbox" id="fl-flyer"'+(draft.withFlyer?' checked':'')+'><span><strong>Enviar la ficha del curso con el saludo</strong><small>La imagen y los datos vigentes del curso van junto al primer mensaje.</small></span></label>'
      +'<label class="fl-check"><input type="checkbox" id="fl-enabled"'+(draft.enabled?' checked':'')+'><span><strong>Flujo encendido para esta marca</strong><small>Funciona cuando la marca responde sola («Plantillas» o «Autónomo» en Seguimientos). Apagado, el saludo es el de siempre.</small></span></label></div>'
      +'<p class="crm-hint">Datos disponibles en los mensajes: <code class="cn-code">{{nombre}}</code> · <code class="cn-code">{{curso}}</code> · <code class="cn-code">{{edicion}}</code> · <code class="cn-code">{{marca}}</code>. Cada botón admite hasta '+limits.label+' caracteres.</p>'
      +'<div class="actions"><button type="button" class="btn primary" data-action="fl-save">'+icon('save')+' Guardar flujo</button><button type="button" class="btn" data-action="fl-test">'+icon('play')+' Actualizar vista previa</button><button type="button" class="btn fl-quiet" data-action="fl-reset">Volver al guardado</button></div></section>'
      +preview()+'</div>';
  }
  async function action(name,el){
    collect();
    if(name==='fl-add-step'){draft.steps.push({id:newId(),text:'',buttons:[]});touch();return 'reload';}
    if(name==='fl-del-step'){const id=el.dataset.id;draft.steps=draft.steps.filter(s=>s.id!==id);for(const s of draft.steps)s.buttons=s.buttons.filter(b=>b.go!=='step:'+id);sim=null;touch();return 'reload';}
    if(name==='fl-add-btn'){const s=draft.steps.find(x=>x.id===el.dataset.id);if(s&&s.buttons.length<limits.buttons)s.buttons.push({label:'',go:'action:price'});touch();return 'reload';}
    if(name==='fl-del-btn'){const s=draft.steps.find(x=>x.id===el.dataset.id);if(s)s.buttons.splice(Number(el.dataset.index),1);sim=null;touch();return 'reload';}
    if(name==='fl-test'||name==='fl-restart'){sim=null;return 'reload';}
    if(name==='fl-reset'){if(dirty&&!confirm('¿Descartar los cambios y volver al flujo guardado?'))return true;startDraft(current());return 'reload';}
    if(name==='fl-press'){
      const step=draft.steps.find(s=>s.id===sim?.step)||draft.steps[0],b=step?.buttons[Number(el.dataset.index)];if(!b)return true;
      sim.log.push({who:'in',text:b.label});const [kind,target]=String(b.go).split(':');
      if(kind==='step'){const next=draft.steps.find(s=>s.id===target);if(next){sim.step=next.id;sim.log.push({who:'out',text:fill(next.text)});}}
      else{sim.log.push({who:'note',text:SIM_NOTE[target]||''});if(target==='enroll'||target==='human')sim.ended=true;}
      return 'reload';
    }
    if(name==='fl-save'){
      const f=current(),r=await api('/api/flows/'+encodeURIComponent(brand),{method:'PUT',body:{enabled:draft.enabled,withFlyer:draft.withFlyer,steps:draft.steps,expectedRevision:f.revision}});
      flows=flows.map(x=>x.brandId===brand?r.flow:x);startDraft(r.flow);toast(r.flow.enabled?'Flujo guardado y encendido.':'Flujo guardado. Está apagado: actívalo cuando quieras usarlo.');return 'reload';
    }
    return false;
  }
  return {load,html,action,setBrand,touch};
};
