// Resumen de conversación (docs/PLAN_RESUMEN_CONVERSACION.md): una tarjeta plegable arriba del chat, sólo para el equipo. Se carga al abrir el
// chat (GET) y se genera o actualiza con un botón (POST). Dice cómo se hizo (reglas o IA) y cuántos mensajes nuevos hay desde entonces.
window.createSummaryUI=function({state,api,esc,icon,toast}){
  const $=s=>document.querySelector(s);
  const cache=new Map(),opened=new Set();   // conversationId -> {summary, at}; chats con la tarjeta abierta (el chat se redibuja seguido)
  const ago=t=>{const m=Math.max(0,Math.round((Date.now()-t)/60000));return m<1?'ahora':m<60?'hace '+m+' min':m<1440?'hace '+Math.round(m/60)+' h':'hace '+Math.round(m/1440)+' d';};
  function paint(id,s,busy=false){
    const box=$('#conv-summary');if(!box||box.dataset.id!==id)return;
    const open=opened.has(id);
    if(!s){box.innerHTML=`<div class="sum-empty"><span>${icon('sparkles')} Resumen de la conversación</span><button type="button" class="btn" data-action="sum-refresh" data-id="${esc(id)}" ${busy?'disabled':''}>${busy?'Resumiendo…':'Generar resumen'}</button></div>`;window.lucide?.createIcons({attrs:{'stroke-width':1.7}});return;}
    const lines=s.text.split('\n').filter(Boolean);
    box.innerHTML=`<details class="sum-card" ${open?'open':''}><summary>${icon('sparkles')} <strong>Resumen</strong><small>${esc(ago(s.updatedAt))} · ${s.source==='ai'?'con IA':'por reglas'}${s.newMessages?` · <b>${s.newMessages} mensaje${s.newMessages===1?'':'s'} nuevo${s.newMessages===1?'':'s'}</b>`:''}</small></summary>
      <div class="sum-body">${lines.map((l,i)=>`<p class="${i===0?'sum-lead':''}${/^Siguiente paso/.test(l)?' sum-next':''}">${esc(l)}</p>`).join('')}<div class="actions"><button type="button" class="btn" data-action="sum-refresh" data-id="${esc(id)}" ${busy?'disabled':''}>${busy?'Actualizando…':'Actualizar resumen'}</button></div></div></details>`;
    const d=box.querySelector('details');d?.addEventListener('toggle',()=>{if(d.open)opened.add(id);else opened.delete(id);});
    window.lucide?.createIcons({attrs:{'stroke-width':1.7}});
  }
  async function mount(c){
    const box=$('#conv-summary');if(!box)return;box.dataset.id=c.id;
    const hit=cache.get(c.id);if(hit)paint(c.id,hit.summary);
    if(hit&&Date.now()-hit.at<30000)return;
    try{const r=await api('/api/conversations/'+c.id+'/summary');cache.set(c.id,{summary:r.summary,at:Date.now()});paint(c.id,r.summary);}catch{if(!hit)box.innerHTML='';}
  }
  async function action(name,el){
    if(name!=='sum-refresh')return false;
    const id=el.dataset.id;paint(id,cache.get(id)?.summary||null,true);
    try{const r=await api('/api/conversations/'+id+'/summary',{method:'POST',body:{}});cache.set(id,{summary:r.summary,at:Date.now()});paint(id,r.summary);}
    catch(e){toast(e.message);paint(id,cache.get(id)?.summary||null);}
    return true;
  }
  return {mount,action};
};
