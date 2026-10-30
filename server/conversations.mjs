// All search predicates live inside the permission-scoped query, including message text.
export function conversationPage(db,user,options={},online=()=>false){
  const isStaff=['admin','agent'].includes(user.role),size=options.size||50;
  const query=String(options.q||'').trim().slice(0,100),cursor=String(options.cursor||'');
  const match=cursor.match(/^(\d+):([a-zA-Z0-9-]+)$/);
  if(cursor&&!match)throw Object.assign(new Error('Página de conversaciones no válida.'),{status:400});
  const params={user:user.id,admin:user.role==='admin'?1:0,agent:user.role==='agent'?1:0,
    query,brand:options.brand||'all',channel:options.channel||'all',filter:options.filter||'all',
    onlyOwn:options.mode==='customer'?1:0,id:options.id||'',limit:size+1,offset:options.offset||0,
    cursorTime:match?Number(match[1]):Number.MAX_SAFE_INTEGER,cursorId:match?.[2]||'',hasCursor:match?1:0};
  const rows=db.prepare(`SELECT c.*,COALESCE(o.stage,CASE WHEN c.stage='inscrito' THEN 'ganada' ELSE c.stage END) AS stage,
    o.id opportunity_id,o.revision opportunity_revision,u.name customer_name,u.test_number,b.name brand_name,k.title course_title,
    a.name agent_name,(SELECT text FROM messages m WHERE m.conversation_id=c.id ORDER BY seq DESC LIMIT 1) last_text,
    (SELECT text FROM messages m WHERE @query!='' AND m.conversation_id=c.id AND instr(search_text(m.text),search_text(@query))>0 ORDER BY seq DESC LIMIT 1) match_text,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.read_at IS NULL AND m.sender_kind IN ('agent','automation')) customer_unread,
    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id=c.id AND m.read_at IS NULL AND ${isStaff?"m.sender_kind='customer'":"m.sender_kind IN ('agent','automation')"}) unread
    FROM conversations c JOIN users u ON u.id=c.customer_id JOIN brands b ON b.id=c.brand_id JOIN courses k ON k.id=c.course_id
    LEFT JOIN users a ON a.id=c.assigned_to LEFT JOIN conversation_opportunities co ON co.conversation_id=c.id LEFT JOIN opportunities o ON o.id=co.opportunity_id
    WHERE (c.customer_id=@user OR @admin=1 OR (@agent=1 AND EXISTS(SELECT 1 FROM brand_members bm WHERE bm.user_id=@user AND bm.brand_id=c.brand_id)))
    AND (@onlyOwn=0 OR c.customer_id=@user) AND (@id='' OR c.id=@id)
    AND (@brand='all' OR c.brand_id=@brand) AND (@channel='all' OR c.channel=@channel)
    AND (@filter='all' OR (@filter='waiting' AND c.status='waiting') OR (@filter='mine' AND c.assigned_to=@user) OR (@filter='open' AND c.status!='resolved') OR (@filter='resolved' AND c.status='resolved'))
    AND (@query='' OR instr(search_text(u.name||' '||u.test_number||' '||b.name||' '||k.title),search_text(@query))>0
      OR EXISTS(SELECT 1 FROM messages sm WHERE sm.conversation_id=c.id AND instr(search_text(sm.text),search_text(@query))>0))
    AND (@hasCursor=0 OR c.updated_at<@cursorTime OR (c.updated_at=@cursorTime AND c.id<@cursorId))
    ORDER BY c.updated_at DESC,c.id DESC LIMIT @limit OFFSET @offset`).all(params);
  const conversations=rows.slice(0,size).map(c=>({...c,customer_online:online(c.customer_id)}));
  return {conversations,nextCursor:rows.length>size?`${conversations.at(-1).updated_at}:${conversations.at(-1).id}`:null};
}
