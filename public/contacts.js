window.createContactsUI=function({state,api,esc,icon,showModal,toast,getData,rerender,openContact}){
  const $=s=>document.querySelector(s),admin=()=>state.user?.role==='admin';
  const COLORS={neutral:'Gris',blue:'Azul',green:'Verde',amber:'Ámbar',red:'Rojo',violet:'Violeta'};
  const REASON={phone:'Mismo teléfono',email:'Mismo correo',name:'Mismo nombre'};
  let tagFilter='',dupBrand='';
  const info=()=>getData().tagInfo||{tags:[],links:{}};
  const tagsFor=c=>(info().links[c.id]||[]).map(id=>info().tags.find(t=>t.id===id)).filter(Boolean);
  const chip=t=>`<span class="ctc-tag ${esc(t.color)}">${esc(t.name)}</span>`;
  const chips=c=>tagsFor(c).map(chip).join('')||'<span class="muted">—</span>';
  const matches=c=>!tagFilter||(info().links[c.id]||[]).includes(tagFilter);
  const brandName=id=>state.brands.find(b=>b.id===id)?.name||'';
  const scopedTags=()=>info().tags.filter(t=>state.brand==='all'||t.brand_id===state.brand);

  function toolbar(){
    const tags=scopedTags();if(tagFilter&&!tags.some(t=>t.id===tagFilter))tagFilter='';
    return `<div class="ctc-toolbar"><label class="ctc-filter">Etiqueta<select id="ctc-tag-filter"><option value="">Todas</option>${tags.map(t=>`<option value="${t.id}" ${t.id===tagFilter?'selected':''}>${esc(state.brand==='all'?brandName(t.brand_id)+' · '+t.name:t.name)}</option>`).join('')}</select></label><button type="button" class="btn" data-action="ctc-duplicates">${icon('copy')} Duplicados</button>${admin()?`<button type="button" class="btn" data-action="ctc-export">${icon('download')} Exportar</button>`:''}</div>`;
  }

  function tagBlock(c){
    const all=info().tags.filter(t=>t.brand_id===c.brand_id),mine=new Set(info().links[c.id]||[]);
    return `<div class="ctc-block"><h3 class="modal-section-title">Etiquetas</h3>
      <form id="ctc-tags-form" class="ctc-tags-form"><input type="hidden" name="contactId" value="${esc(c.id)}">${all.length?`<div class="ctc-pick">${all.map(t=>`<label class="ctc-pick-item"><input type="checkbox" name="tag" value="${t.id}" ${mine.has(t.id)?'checked':''}><span class="ctc-tag ${esc(t.color)}">${esc(t.name)}</span></label>`).join('')}</div><button class="btn" type="submit">Guardar etiquetas</button>`:'<p class="crm-hint">Esta marca todavía no tiene etiquetas. Crea la primera aquí.</p>'}</form>
      <form id="ctc-tag-form" class="ctc-newtag"><input type="hidden" name="brandId" value="${esc(c.brand_id)}"><input type="hidden" name="contactId" value="${esc(c.id)}"><input name="name" maxlength="30" required placeholder="Nueva etiqueta" aria-label="Nombre de la etiqueta"><select name="color" aria-label="Color">${Object.entries(COLORS).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select><button class="btn" type="submit">Crear</button></form></div>`;
  }

  async function duplicates(){
    const brandId=state.brand!=='all'?state.brand:(dupBrand||state.brands[0]?.id);dupBrand=brandId;
    const r=await api('/api/crm/duplicates?brand='+encodeURIComponent(brandId));
    showModal('Posibles duplicados',`<div class="ctc-dups">${state.brand==='all'?`<label class="field">Marca<select id="ctc-dup-brand">${state.brands.map(b=>`<option value="${b.id}" ${b.id===brandId?'selected':''}>${esc(b.name)}</option>`).join('')}</select></label>`:`<span class="pill">${esc(brandName(brandId))}</span>`}
      <p class="crm-hint">Coincidencias por teléfono, correo o nombre completo (sin acentos). ${admin()?'Elige qué ficha conservar para ver la fusión antes de confirmarla.':'La fusión la hace un administrador.'}</p>
      ${r.groups.length?r.groups.map(g=>`<article class="ctc-group"><div class="ctc-group-top"><strong>${REASON[g.reason]}</strong><small>${g.contacts.length} fichas</small></div>${g.contacts.map(c=>`<div class="ctc-dup"><div><strong>${esc(c.name)}</strong><small>${esc(c.phone||'Sin teléfono')} · ${esc(c.email||'Sin correo')}</small><small>${c.opportunities} interés(es) · ${c.notes} nota(s)${c.linked?' · perfil vinculado':''}</small></div>${admin()?`<button type="button" class="btn" data-action="ctc-merge-preview" data-keep="${c.id}" data-merge="${g.contacts.find(x=>x.id!==c.id).id}">Conservar esta</button>`:''}</div>`).join('')}</article>`).join(''):'<div class="crm-empty">'+icon('check')+'<h3>Sin duplicados</h3><p>No hay fichas repetidas en esta marca.</p></div>'}</div>`);
  }
  async function mergePreview(keepId,mergeId){
    const p=(await api('/api/crm/contacts/merge-preview',{method:'POST',body:{keepId,mergeId}})).plan,card=(label,c)=>`<div class="ctc-merge-card"><small>${label}</small><strong>${esc(c.name)}</strong><span>${esc(c.phone||'Sin teléfono')} · ${esc(c.email||'Sin correo')}</span><span>${c.opportunities} interés(es) · ${c.notes} nota(s)</span></div>`;
    showModal('Revisar fusión',`<div class="ctc-merge">${card('Se conserva',p.keep)}${card('Se une y desaparece',p.merge)}
      <ul class="ctc-moves"><li>${p.moves.opportunities} interés(es) pasan a la ficha principal</li><li>${p.moves.notes} nota(s) interna(s)</li><li>${p.moves.tags} etiqueta(s) nueva(s)</li>${p.fill.phone?'<li>Se completará el teléfono</li>':''}${p.fill.email?'<li>Se completará el correo</li>':''}</ul>
      ${p.problems.length?`<ul class="imp-errors">${p.problems.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<p class="crm-hint">Queda una nota en la ficha con lo que se unió. La fusión no se puede deshacer desde la interfaz.</p>'}
      <div class="actions"><button type="button" class="btn" data-action="ctc-duplicates">Volver</button>${p.canMerge?`<button type="button" class="btn primary" data-action="ctc-merge" data-keep="${p.keep.id}" data-merge="${p.merge.id}" data-token="${esc(p.previewToken)}">Fusionar fichas</button>`:''}</div></div>`);
  }
  function exportDialog(){
    const brand=state.brand!=='all'?state.brand:'',q=(extra={})=>{const p=new URLSearchParams({...(brand?{brand}:{}),...extra});const s=p.toString();return s?'?'+s:'';};
    showModal('Exportar a CSV',`<div class="ctc-export"><p class="crm-hint">Archivos para Excel o Google Sheets (UTF-8). Incluyen datos personales: guárdalos con cuidado. Cada exportación queda registrada.${brand?' Sólo de '+esc(brandName(brand))+'.':' De todas las marcas.'}</p>
      <a class="btn" href="/api/crm/export/contacts.csv${q(tagFilter?{tag:tagFilter}:{})}" download>${icon('download')} Contactos${tagFilter?' (con la etiqueta elegida)':''}</a>
      <a class="btn" href="/api/crm/export/opportunities.csv${q()}" download>${icon('download')} Oportunidades</a></div>`);
  }

  async function action(name,el){
    try{
      if(name==='ctc-duplicates'){await duplicates();return true;}
      if(name==='ctc-export'){exportDialog();return true;}
      if(name==='ctc-merge-preview'){await mergePreview(el.dataset.keep,el.dataset.merge);return true;}
      if(name==='ctc-merge'){await api('/api/crm/contacts/merge',{method:'POST',body:{keepId:el.dataset.keep,mergeId:el.dataset.merge,previewToken:el.dataset.token}});toast('Fichas fusionadas');await rerender();await duplicates();return true;}
    }catch(e){toast(e.message);}
    return true;
  }
  async function submit(form,input){
    try{
      if(form.id==='ctc-tags-form'){await api('/api/crm/contacts/'+input.contactId+'/tags',{method:'PUT',body:{tagIds:new FormData(form).getAll('tag')}});toast('Etiquetas guardadas');await rerender();await openContact(input.contactId);}
      if(form.id==='ctc-tag-form'){await api('/api/crm/tags',{method:'POST',body:{brandId:input.brandId,name:input.name,color:input.color}});toast('Etiqueta creada');await rerender();await openContact(input.contactId);}
    }catch(e){toast(e.message);}
    return true;
  }
  async function change(target){
    if(target.id==='ctc-tag-filter'){tagFilter=target.value;await rerender();return true;}
    if(target.id==='ctc-dup-brand'){dupBrand=target.value;await duplicates();return true;}
    return false;
  }
  return {toolbar,chips,matches,tagBlock,action,submit,change};
};
