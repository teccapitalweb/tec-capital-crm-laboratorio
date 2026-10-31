const formatters=new Map();
export const defaultHours=()=>[null,[540,1080],[540,1080],[540,1080],[540,1080],[540,1080],null];
export function validateHours(hours,zone){
  try{new Intl.DateTimeFormat('en',{timeZone:zone});}catch{throw Error('Zona horaria no válida.');}
  if(!Array.isArray(hours)||hours.length!==7||!hours.some(Boolean)||hours.some(h=>h!==null&&(!Array.isArray(h)||h.length!==2||h.some(x=>!Number.isInteger(x))||h[0]<0||h[1]>1440||h[0]>=h[1])))throw Error('Define al menos un día y un intervalo válido por día, sin cruzar medianoche.');
  return hours;
}
function parts(t,zone){let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat('en-US',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});formatters.set(zone,f);}return Object.fromEntries(f.formatToParts(t).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));}
export function isOpen(t,policy){const p=parts(t,policy.timezone),d=new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay(),h=policy.hours[d],m=p.hour*60+p.minute;return Boolean(h&&m>=h[0]&&m<h[1]);}
// Count real elapsed minutes only while the local business calendar is open.
// Iterating real instants handles missing/repeated hours at DST transitions.
export function serviceDeadline(start,minutes,policy){
  let t=start,remaining=minutes*60000;const stop=start+370*86400000;
  while(t<stop&&remaining>0){const boundary=(Math.floor(t/60000)+1)*60000,span=boundary-t;if(isOpen(t,policy)){if(remaining<=span)return t+remaining;remaining-=span;}t=boundary;}
  throw Error('El horario no permite calcular el objetivo dentro de un año.');
}
