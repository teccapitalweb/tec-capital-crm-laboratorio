const formatters=new Map();
export const defaultHours=()=>[null,[540,1080],[540,1080],[540,1080],[540,1080],[540,1080],null];
export function validateHours(hours,zone){
  try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw Error('Zona horaria no válida.');}
  if(!Array.isArray(hours)||hours.length!==7||!hours.some(Boolean)||hours.some(h=>h!==null&&(!Array.isArray(h)||h.length!==2||h.some(x=>!Number.isInteger(x))||h[0]<0||h[1]>1440||h[0]>=h[1])))throw Error('Define al menos un día y un intervalo válido por día, sin cruzar medianoche.');
  return hours;
}
function parts(t,zone){let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatters.set(zone,f);}return Object.fromEntries(f.formatToParts(t).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
const holidaySets=new WeakMap();
const holidaySet=policy=>{let s=holidaySets.get(policy);if(!s){s=new Set((policy.holidays||[]).map(h=>typeof h==='string'?h:h.date));holidaySets.set(policy,s);}return s;};
const pad=n=>String(n).padStart(2,'0');
// Fechas AAAA-MM-DD reales (sin 30 de febrero) de a lo sumo 3 años atrás o 5 adelante; un festivo cierra todo ese día en la zona de la marca.
export function validateHolidays(list,now=Date.now()){
  if(list===undefined)return undefined;
  if(!Array.isArray(list)||list.length>150)throw Error('Los festivos deben ser una lista de hasta 150 fechas.');
  const seen=new Set(),out=[],min=now-3*366*86400000,max=now+5*366*86400000;
  for(const h of list){
    const date=typeof h==='string'?h:h?.date,name=typeof h==='string'?'':String(h?.name??'').trim().replace(/\s+/g,' ').slice(0,60);
    const m=typeof date==='string'&&date.match(/^(\d{4})-(\d{2})-(\d{2})$/);if(!m)throw Error('Cada festivo necesita una fecha AAAA-MM-DD válida: '+String(date).slice(0,12)+'.');
    const t=Date.UTC(+m[1],+m[2]-1,+m[3]);if(new Date(t).getUTCMonth()!==+m[2]-1)throw Error('La fecha '+date+' no existe.');
    if(t<min||t>max)throw Error('La fecha '+date+' está fuera del rango permitido (3 años atrás a 5 adelante).');
    if(seen.has(date))throw Error('La fecha '+date+' está repetida.');seen.add(date);out.push({date,name});
  }
  return out.sort((a,b)=>a.date<b.date?-1:1);
}
export function isOpen(t,policy){const p=parts(t,policy.timezone);if(policy.holidays?.length&&holidaySet(policy).has(p.year+'-'+pad(p.month)+'-'+pad(p.day)))return false;const d=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay(),h=policy.hours[d],m=p.hour*60+p.minute;return Boolean(h&&m>=h[0]&&m<h[1]);}
// Count real elapsed minutes only while the local business calendar is open.
// Iterating real instants handles missing/repeated hours at DST transitions.
export function serviceDeadline(start,minutes,policy){
  let t=start,remaining=minutes*60000;const stop=start+370*86400000;
  while(t<stop&&remaining>0){const boundary=(Math.floor(t/60000)+1)*60000,span=boundary-t;if(isOpen(t,policy)){if(remaining<=span)return t+remaining;remaining-=span;}t=boundary;}
  throw Error('El horario no permite calcular el objetivo dentro de un año.');
}
