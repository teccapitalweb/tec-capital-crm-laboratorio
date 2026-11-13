// Service worker de TEC Capital: sólo recibe notificaciones push y las muestra. No guarda nada en caché ni intercepta peticiones,
// así que no puede dejar la aplicación en una versión vieja. docs/PLAN_PUSH.md
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'TEC Capital';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : undefined,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { url: typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/crm' },
    }),
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = event.notification.data?.url || '/crm';
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of open) {
        if (new URL(client.url).pathname.startsWith('/crm') && 'focus' in client) return client.focus();
      }
      return self.clients.openWindow(url);
    })(),
  );
});
