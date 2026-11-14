// Meta de mentira para las pruebas de punta a punta: la Graph API mínima que usa el CRM (enviar un mensaje, leer los
// datos de un archivo y descargarlo), con dos mandos para las pruebas de trabajo duradero:
//   hold('send' | 'download')  las peticiones de ese tipo se quedan sin respuesta hasta release(…): así un envío o
//                              una descarga se queda «en vuelo» todo el tiempo que la prueba necesite.
//   delays.send                milisegundos que tarda en responder un envío.
// Nada sale a internet y todos los datos son inventados.
import { createServer } from 'node:http';
import { hmacHex } from '../../server/connectors.mjs';

export const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 7)]);
export const TOKEN = 'EAAprueba0000000000000000000000token';
export const SECRET = 'app-secret-prueba';
export const NUMBER = '109000000000001';

export async function startFakeMeta() {
  const sent = [];
  const downloads = [];
  const delays = { send: 0 };
  const held = { send: [], download: [] };
  const holding = { send: false, download: false };
  let n = 0;
  const gate = (kind, respond) => {
    if (holding[kind]) held[kind].push(respond);
    else respond();
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      const send = (status, data) => {
        if (res.destroyed) return;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      if (req.headers.authorization !== 'Bearer ' + TOKEN)
        return send(401, { error: { code: 190, message: 'Invalid OAuth access token' } });
      let match;
      if ((match = url.pathname.match(/^\/download\/(\d+)$/))) {
        downloads.push(match[1]);
        return gate('download', () => {
          if (res.destroyed) return;
          res.writeHead(200, { 'content-type': 'image/png' });
          res.end(PNG);
        });
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)\/messages$/)) && req.method === 'POST') {
        const body = JSON.parse(Buffer.concat(chunks).toString());
        sent.push({ from: match[1], ...body });
        const id = 'wamid.out' + ++n;
        return gate('send', () =>
          setTimeout(
            () => send(200, { messaging_product: 'whatsapp', contacts: [{ wa_id: body.to }], messages: [{ id }] }),
            delays.send,
          ),
        );
      }
      if ((match = url.pathname.match(/^\/v25\.0\/(\d+)$/)) && req.method === 'GET') {
        if (match[1] === NUMBER)
          return send(200, { display_phone_number: '+1 555 010 0000', verified_name: 'Test Number', id: NUMBER });
        // cualquier otro identificador numérico es un archivo que la persona envió
        return send(200, {
          url: 'http://127.0.0.1:' + server.address().port + '/download/' + match[1],
          mime_type: 'image/png',
          file_size: PNG.length,
          id: match[1],
        });
      }
      send(404, { error: { code: 100, message: 'ruta desconocida' } });
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const url = 'http://127.0.0.1:' + server.address().port;
  return {
    url,
    sent,
    downloads,
    delays,
    hold(kind) {
      holding[kind] = true;
    },
    release(kind) {
      holding[kind] = false;
      for (const respond of held[kind].splice(0)) respond();
    },
    waiting: kind => held[kind].length,
    // Variables de entorno de un servidor con WhatsApp real completo, apuntando a este Meta de mentira.
    env: {
      CHANNEL_CONNECTOR: 'meta',
      META_ACCESS_TOKEN: TOKEN,
      META_APP_SECRET: SECRET,
      META_VERIFY_TOKEN: 'verifica-123',
      META_PHONE_NUMBER_ID: NUMBER,
      META_GRAPH_URL: url,
      META_GRAPH_VERSION: '',
      AI_PROVIDER: '',
    },
    close: () =>
      new Promise(done => {
        for (const kind of ['send', 'download']) held[kind].length = 0;
        server.closeAllConnections();
        server.close(done);
      }),
  };
}

// Un webhook firmado como lo manda Meta. `value` es el contenido de entry[].changes[].value.
export async function metaHook(origin, value, { secret = SECRET } = {}) {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', ...value } }] }],
  });
  const response = await fetch(origin + '/api/webhooks/channel/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + hmacHex(secret, raw) },
    body: raw,
  });
  return { status: response.status, body: await response.json() };
}

// Un mensaje entrante de una persona. `message` es lo propio del tipo: {type:'text', text:{body}} o {type:'image', image:{…}}.
export const metaInbound = (origin, from, id, message, { to = NUMBER, name = 'Persona de prueba' } = {}) =>
  metaHook(origin, {
    metadata: { display_phone_number: '15550100000', phone_number_id: to },
    contacts: [{ profile: { name }, ...(from ? { wa_id: from } : {}) }],
    messages: [{ ...(from ? { from } : {}), id, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
  });
export const metaText = (origin, from, id, body, options) =>
  metaInbound(origin, from, id, { type: 'text', text: { body } }, options);
