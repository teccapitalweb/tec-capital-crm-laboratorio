// Identidad única de persona: lista de personas entre marcas, ficha (marcas, oportunidades, pedidos, inscripciones,
// consentimiento con historial), edición, candidaturas para revisar y fusión con vista previa (administración).
window.createPersonsUI=function({state,api,esc,icon,showModal,toast,openContact,openConversation,rerender}){
  const $=s=>document.querySelector(s),admin=()=>state.user?.role==='admin';
  const stamp=t=>t?new Intl.DateTimeFormat('es-MX',{dateStyle:'medium',timeStyle:'short'}).format(t):'—';
  const money=(c,cur)=>new Intl.NumberFormat('es-MX',{style:'currency',currency:cur||'MXN'}).format((c||0)/100);
  const tag=(label,kind='')=>`<span class="ctc-tag ${kind}">${esc(label)}</span>`;
  const btn=(action,label,id='',extra='',klass='')=>`<button type="button" class="btn ${klass}" data-action="prs-${action}" data-id="${esc(id)}" ${extra}>${label}</button>`;
  const CONSENT={unknown:['Sin registro',''],opted_in:['Acepta mensajes','green'],opted_out:['No desea mensajes','red']};
  const SOURCE={staff:'Registrado por el equipo',customer_message:'Lo pidió el cliente por mensaje',merge:'Heredado de una fusión',person:'Proyectado desde la persona',backfill:'Relleno inicial'};
  const STAGE={nuevo:'Nuevo',interesado:'Interesado',inscripcion:'Inscripción solicitada',ganada:'Ganada',perdida:'Perdida'};
  const RUN={planned:'planeada',open:'abierta',running:'en curso',closed:'cerrada',cancelled:'cancelada'};
  const REASON={name:'Mismo nombre',identity_conflict:'Identidades en conflicto'};
  let query='';
  const row=p=>`<div class="ctc-dup prs-row"><div><strong>${esc(p.name)}</strong><small>${esc(p.phone||'Sin teléfono')} · ${esc(p.email||'Sin correo')}${p.profile?' · perfil'+(p.testNumber?' #'+p.testNumber:''):''}</small><small>${p.brands.map(b=>esc(b.name)).join(', ')}${p.otherBrands?' · +'+p.otherBrands+' marca(s) sin acceso':''} · ${p.opportunities} interés(es) · ${p.enrollments} inscripción(es)${p.paidCents?' · '+money(p.paidCents):''}</small></div><div class="prs-side">${tag(...CONSENT[p.consent])}${btn('open','Ver persona',p.id)}</div></div>`;
  async function list(){
    const r=await api('/api/persons?'+new URLSearchParams({brand:state.brand,q:query}));
    showModal('Personas',`<div class="ctc-dups"><p class="crm-hint">Una persona reúne sus contactos en las distintas marcas: mismo perfil del laboratorio, teléfono o correo. Ves sólo las marcas a las que tienes acceso.</p><form id="prs-search" class="ctc-newtag"><input name="q" value="${esc(query)}" maxlength="80" placeholder="Nombre, teléfono o correo" aria-label="Buscar persona"><button class="btn" type="submit">Buscar</button>${admin()?btn('candidates',icon('git-merge')+' Por revisar'):''}</form>${r.persons.length?r.persons.map(row).join(''):'<p class="crm-hint">Sin personas con esa búsqueda.</p>'}</div>`);
  }
  async function detail(id){
    const d=await api('/api/persons/'+id),p=d.person,c=d.consent,[cl,ck]=CONSENT[c.status],locked=c.status==='opted_out'&&!admin();
    showModal(esc(p.name),`<div class="ctc-dups prs-detail">
      <div class="ctc-consent-top">${tag(cl,ck)}${p.profile?tag('Perfil del laboratorio'+(p.testNumber?' #'+p.testNumber:'')):''}${p.brands.map(b=>tag(b.name)).join('')}${p.otherBrands?`<small>+${p.otherBrands} marca(s) sin acceso</small>`:''}</div>
      <p class="crm-hint">${esc(p.phone||'Sin teléfono')} · ${esc(p.email||'Sin correo')} · ${d.identities.length} identidad(es)</p>
      ${p.canEdit?`<form id="prs-edit" class="form-grid"><input type="hidden" name="personId" value="${esc(p.id)}"><input type="hidden" name="expectedRevision" value="${p.revision}"><div class="cat-form-columns"><label class="field">Nombre<input name="name" required maxlength="100" value="${esc(p.name)}"></label><label class="field">Teléfono (E.164)<input name="phone" maxlength="40" value="${esc(p.phone)}" placeholder="+52 55 1234 5678"></label><label class="field">Correo<input name="email" type="email" maxlength="150" value="${esc(p.email)}"></label></div><div class="actions"><button class="btn" type="submit">Guardar persona</button></div><div class="ops-feedback" role="status"></div></form>`:'<p class="crm-hint">Los datos de la persona valen para toda la empresa y tiene contactos en marcas a las que no tienes acceso: edita el contacto de tu marca o pide el cambio a administración.</p>'}
      <h3 class="modal-section-title">Comunicaciones (toda la empresa)</h3><div class="ctc-consent-top">${tag(cl,ck)}${c.source?`<small>${esc(SOURCE[c.source]||c.source)}${c.updated_at?' · '+stamp(c.updated_at):''}</small>`:''}</div>${c.note?`<p class="crm-hint">${esc(c.note)}</p>`:''}
      ${locked?'<p class="crm-hint">Esta persona pidió no recibir mensajes de ninguna marca. Sólo administración puede reactivarla, explicando el motivo.</p>':`<div class="ctc-consent-form"><input id="prs-consent-note" maxlength="200" placeholder="${c.status==='opted_out'?'Motivo para reactivar (obligatorio)':'Nota (opcional)'}" aria-label="Nota del consentimiento"><div class="actions">${c.status!=='opted_out'?btn('consent','Registrar consentimiento',p.id,'data-status="opted_in"')+btn('consent','Marcar baja',p.id,'data-status="opted_out"'):btn('consent','Reactivar mensajes',p.id,'data-status="opted_in"')}</div></div>`}
      ${d.consentHistory.length?`<details class="ctc-history"><summary>Historial (${d.consentHistory.length})</summary>${d.consentHistory.map(h=>`<div><b>${esc(CONSENT[h.status][0])}</b><small>${esc(SOURCE[h.source]||h.source)}${h.brand_name?' · '+esc(h.brand_name):h.redacted?' · otra marca':''}${h.actor_name?' · '+esc(h.actor_name):''} · ${stamp(h.created_at)}${h.note?' · '+esc(h.note):''}</small></div>`).join('')}</details>`:''}
      <h3 class="modal-section-title">Contactos por marca</h3>${d.contacts.map(x=>`<div class="ctc-dup"><div><strong>${esc(x.brand_name)}</strong><small>${esc(x.name)} · ${esc(x.phone||'sin teléfono')} · ${esc(x.email||'sin correo')} · ${x.source==='manual'?'alta manual':'por conversación'}</small>${x.tags.length?`<small>${x.tags.map(t=>`<span class="ctc-tag ${esc(t.color)}">${esc(t.name)}</span>`).join('')}</small>`:''}</div>${btn('contact','Ficha',x.id)}</div>`).join('')}
      ${d.legacy?.length?`<h3 class="modal-section-title">Históricos IPCIL</h3>${d.legacy.map(r=>`<div class="ctc-dup"><div><strong>${esc(r.kind==='venta'?'Pago histórico · '+new Intl.NumberFormat('es-MX',{style:'currency',currency:r.currency||'MXN'}).format((r.amount_cents||0)/100):r.kind==='certificado'?'Certificado '+esc(r.folio||r.title):'Inscripción · '+esc(r.data.cursoNombre||r.data.cursoId||r.title))}</strong><small>${esc(r.brand_name)}${r.occurred_at?' · '+stamp(r.occurred_at):''}${r.status?' · '+esc(r.status):''}${r.kind==='alumno'&&r.data.vendedor?' · vendedor '+esc(r.data.vendedor):''}${r.kind==='alumno'&&r.data.saldoCents?' · saldo '+new Intl.NumberFormat('es-MX',{style:'currency',currency:'MXN'}).format(r.data.saldoCents/100):''}${r.kind==='venta'&&r.data.metodo?' · '+esc(r.data.metodo):''}</small></div><span class="ops-chip">Histórico</span></div>`).join('')}`:''}
      <h3 class="modal-section-title">Oportunidades</h3>${d.opportunities.map(o=>`<div class="ctc-dup"><div><strong>${esc(o.course_title)}</strong><small>${esc(o.brand_name)} · ${esc(o.edition_name||'')} · ${STAGE[o.stage]||o.stage}${o.owner_name?' · '+esc(o.owner_name):''} · ${stamp(o.updated_at)}</small></div>${o.conversation_id?btn('chat','Chat',o.conversation_id):''}</div>`).join('')||'<p class="crm-hint">Sin oportunidades en tus marcas.</p>'}
      <h3 class="modal-section-title">Pedidos e inscripciones</h3>${d.orders.map(o=>`<div class="ctc-dup"><div><strong>${esc(o.reference)} · ${money(o.amount_cents,o.currency)}</strong><small>${esc(o.brand_name)} · ${esc(o.course_title)} · ${esc(o.edition_name)} · ${({pending:'pendiente',review:'comprobante en revisión',paid:'pagado',cancelled:'cancelado',expired:'vencido'})[o.status]||o.status}${o.paid_at?' · '+stamp(o.paid_at):''}</small></div></div>`).join('')||'<p class="crm-hint">Sin pedidos.</p>'}
      ${d.enrollments.map(e=>`<div class="ctc-dup"><div><strong>Inscripción · ${esc(e.course_title)}</strong><small>${esc(e.brand_name)} · ${esc(e.edition_name)} · apertura ${RUN[e.run_status]||e.run_status} · ${e.status==='enrolled'?'activa':'baja'} · asistencia ${e.attended} de ${e.held}</small></div></div>`).join('')}
      ${admin()&&d.candidates.length?`<h3 class="modal-section-title">Por revisar</h3>${d.candidates.map(x=>{const other=x.person_a===p.id?x.person_b:x.person_a,name=x.person_a===p.id?x.name_b:x.name_a;return `<div class="ctc-dup"><div><strong>${esc(REASON[x.reason])}</strong><small>${esc(x.detail)} · con «${esc(name)}»</small></div><div class="prs-side">${btn('merge-preview','Revisar fusión',p.id,`data-merge="${esc(other)}"`)}${btn('dismiss','No son la misma',x.id)}</div></div>`;}).join('')}`:''}
      <div class="actions">${btn('list','Volver a personas')}</div></div>`);
  }
  async function candidates(){
    const r=await api('/api/persons/candidates');
    showModal('Personas por revisar',`<div class="ctc-dups"><p class="crm-hint">Coincidencias que el sistema no une solo: mismo nombre completo en personas distintas, o teléfono/correo que ya pertenece a otra persona. Revisa la fusión antes de confirmarla; «No son la misma» descarta la candidatura.</p>${r.candidates.length?r.candidates.map(c=>`<article class="ctc-group"><div class="ctc-group-top"><strong>${esc(REASON[c.reason])}</strong><small>${esc(c.detail)}</small></div>${[['a',c.name_a,c.phone_a,c.email_a,c.brands_a,c.person_a,c.person_b],['b',c.name_b,c.phone_b,c.email_b,c.brands_b,c.person_b,c.person_a]].map(([,name,phone,email,brands,keep,merge])=>`<div class="ctc-dup"><div><strong>${esc(name)}</strong><small>${esc(phone||'Sin teléfono')} · ${esc(email||'Sin correo')} · ${brands.map(esc).join(', ')||'sin contactos'}</small></div>${btn('merge-preview','Conservar esta',keep,`data-merge="${esc(merge)}"`)}</div>`).join('')}<div class="actions">${btn('dismiss','No son la misma persona',c.id)}</div></article>`).join(''):'<div class="crm-empty">'+icon('check')+'<h3>Nada por revisar</h3><p>Las identidades coinciden solas o ya se decidieron.</p></div>'}<div class="actions">${btn('list','Volver a personas')}</div></div>`);
  }
  async function mergePreview(keepId,mergeId){
    const p=(await api('/api/persons/merge-preview',{method:'POST',body:{keepId,mergeId}})).plan,card=(label,x)=>`<div class="ctc-merge-card"><small>${label}</small><strong>${esc(x.name)}</strong><span>${esc(x.phone||'Sin teléfono')} · ${esc(x.email||'Sin correo')}</span><span>${x.brands.map(b=>esc(b.name)).join(', ')||'sin marcas visibles'} · ${x.opportunities} interés(es) · ${x.enrollments} inscripción(es)</span></div>`;
    showModal('Revisar fusión de personas',`<div class="ctc-merge">${card('Se conserva',p.keep)}${card('Se une y desaparece',p.merge)}<ul class="ctc-moves"><li>${p.moves.contacts} contacto(s) por marca pasan a la persona principal</li><li>${p.moves.identities} identidad(es)</li>${p.moves.consent?`<li>Hereda el consentimiento «${CONSENT[p.moves.consent][0]}»</li>`:''}${p.moves.fill.phone?'<li>Se completará el teléfono</li>':''}${p.moves.fill.email?'<li>Se completará el correo</li>':''}</ul>${p.problems.length?`<ul class="imp-errors">${p.problems.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:'<p class="crm-hint">Los contactos, oportunidades y pedidos no cambian de marca; sólo pasan a colgar de una misma persona. No se puede deshacer desde la interfaz.</p>'}<div class="actions">${btn('candidates','Volver')}${p.canMerge?btn('merge','Fusionar personas',p.keep.id,`data-merge="${esc(p.merge.id)}" data-token="${esc(p.previewToken)}"`,'primary'):''}</div></div>`);
  }
  async function action(name,el){
    const id=el.dataset.id;
    try{
      if(name==='prs-list'){await list();return true;}
      if(name==='prs-open'){await detail(id);return true;}
      if(name==='prs-candidates'){await candidates();return true;}
      if(name==='prs-contact'){await openContact(id);return true;}
      if(name==='prs-chat'){await openConversation(id);return true;}
      if(name==='prs-consent'){const note=$('#prs-consent-note')?.value||'';await api('/api/persons/'+id+'/consent',{method:'PUT',body:{status:el.dataset.status,note}});toast('Consentimiento actualizado para toda la empresa.');await rerender();await detail(id);return true;}
      if(name==='prs-merge-preview'){await mergePreview(id,el.dataset.merge);return true;}
      if(name==='prs-merge'){const r=await api('/api/persons/merge',{method:'POST',body:{keepId:id,mergeId:el.dataset.merge,previewToken:el.dataset.token}});toast('Personas fusionadas.');await rerender();await detail(r.keepId);return true;}
      if(name==='prs-dismiss'){await api('/api/persons/candidates/'+id+'/dismiss',{method:'POST',body:{}});toast('Candidatura descartada.');await candidates();return true;}
    }catch(e){toast(e.message);}
    return true;
  }
  async function submit(form,input){
    try{
      if(form.getAttribute('id')==='prs-search'){query=input.q||'';await list();return true;}
      if(form.getAttribute('id')==='prs-edit'){await api('/api/persons/'+input.personId,{method:'PATCH',body:{name:input.name,phone:input.phone,email:input.email,expectedRevision:Number(input.expectedRevision)}});toast('Persona guardada.');await rerender();await detail(input.personId);return true;}
    }catch(e){const f=form.querySelector('.ops-feedback');if(f)f.textContent=e.message;toast(e.message);}
    return true;
  }
  const link=c=>c.persona_id?`<p class="crm-hint">Persona: ${btn('open','Ver persona y sus otras marcas',c.persona_id)}</p>`:'';
  return {list,detail,action,submit,link};
};
