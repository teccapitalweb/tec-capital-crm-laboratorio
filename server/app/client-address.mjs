// Dirección real de quien hace la petición, para los límites por dirección.
//
// Detrás de un proxy, la dirección del socket es la del proxy: la misma para todo el mundo. La real viaja en
// X-Forwarded-For, pero esa cabecera también la puede escribir el cliente, así que sólo se cree la parte que
// añadieron NUESTROS proxies: cada proxy añade al final la dirección desde la que recibió la conexión, y con N
// proxies propios la dirección real es la que ocupa la posición N contando desde la derecha. Lo que esté más a la
// izquierda lo pudo inventar el cliente y se ignora.
//
// TRUSTED_PROXY_HOPS = N (0 por omisión: no se mira ninguna cabecera, que es el fallo seguro). Si la cabecera
// falta, es más corta que N o no trae una dirección válida, se usa la del socket.
// TRUSTED_PROXY_CIDRS (opcional): rangos desde los que se acepta la cabecera; si la conexión no viene de ahí, se ignora.
import net from 'node:net';

function normalize(value) {
  let text = String(value || '').trim();
  if (text.startsWith('['))
    text = text.slice(1, text.includes(']') ? text.indexOf(']') : undefined); // [2001:db8::1]:443
  else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(':')); // 203.0.113.7:51234
  if (text.toLowerCase().startsWith('::ffff:') && net.isIPv4(text.slice(7))) text = text.slice(7); // IPv4 dentro de IPv6
  return net.isIP(text) ? text.toLowerCase() : '';
}

// hops = proxies PROPIOS delante del servidor. trusted = net.BlockList con los rangos de esos proxies, o null.
export function clientAddress(req, hops = 0, trusted = null) {
  const remote = normalize(req.socket?.remoteAddress) || 'unknown';
  if (!(hops > 0)) return remote;
  if (trusted && !trusted.check(remote, net.isIPv6(remote) ? 'ipv6' : 'ipv4')) return remote; // quien conecta no es nuestro proxy
  const header = req.headers?.['x-forwarded-for'];
  const list = String(Array.isArray(header) ? header.join(',') : header || '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  return normalize(list[list.length - hops]) || remote;
}

// Clave para limitar: IPv4 tal cual; IPv6 por su prefijo /64 (una persona puede rotar direcciones dentro del suyo).
export function limitKey(ip) {
  if (!net.isIPv6(ip)) return ip;
  const [head, tail = ''] = ip.split('::');
  const first = head ? head.split(':') : [];
  const last = tail ? tail.split(':') : [];
  if (first.length + last.length > 8 || ip.includes('.')) return ip;
  return (
    [...first, ...Array(8 - first.length - last.length).fill('0'), ...last]
      .slice(0, 4)
      .map(group => group.replace(/^0+(?=.)/, ''))
      .join(':') + '::/64'
  );
}

// Lee la configuración del entorno una vez. Un valor que no se entiende cuenta como «sin proxy de confianza».
export function proxyConfig(env = process.env) {
  const hops = Number.parseInt(env.TRUSTED_PROXY_HOPS ?? '0', 10);
  let trusted = null;
  const ranges = String(env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);
  if (ranges.length) {
    trusted = new net.BlockList();
    for (const range of ranges) {
      const [address, prefix] = range.split('/');
      const family = net.isIPv6(address) ? 'ipv6' : 'ipv4';
      if (!net.isIP(address)) throw new Error(`TRUSTED_PROXY_CIDRS: «${range}» no es un rango válido.`);
      if (prefix === undefined) trusted.addAddress(address, family);
      else trusted.addSubnet(address, Number(prefix), family);
    }
  }
  return { hops: Number.isInteger(hops) && hops > 0 && hops <= 5 ? hops : 0, trusted };
}
