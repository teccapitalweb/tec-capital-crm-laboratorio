-- Núcleo de datos compartido de TEC Capital · esquema v1 (PostgreSQL / Supabase).
-- Fase 2 · bloque 2.7, ruta 1: «núcleo compartido primero, CRM intacto». El CRM (SQLite) sigue operando y envía sus
-- hechos al núcleo por el outbox firmado (docs/NUCLEO.md); la Academia y el IPCIL nuevo leen y escriben aquí.
-- Convenciones: nombres en español; cada tabla de negocio lleva (origen, origen_id) únicos para «upsert» idempotente
-- desde cualquier sistema (crm, academia, ipcil); los importes van en centavos enteros; las fechas en timestamptz.
-- Este archivo es la referencia versionada; aplicarlo requiere acceso al proyecto de Supabase de la Academia (pendiente).

create schema if not exists nucleo;

create table if not exists nucleo.consultoras (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  clave         text not null,                        -- identificador corto estable (p. ej. globalvet)
  nombre        text not null,
  comision_bp   integer not null default 0 check (comision_bp between 0 and 10000),
  activa        boolean not null default true,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id),
  unique (clave)
);

create table if not exists nucleo.personas (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,                        -- id de persona del CRM, o 'contacto:<id>' cuando aún no hay persona
  nombre        text not null,
  telefono      text,                                 -- E.164
  correo        text,
  consentimiento text not null default 'unknown' check (consentimiento in ('unknown','opted_in','opted_out')),
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id)
);

create table if not exists nucleo.identidades (
  persona_id    uuid not null references nucleo.personas(id) on delete cascade,
  tipo          text not null check (tipo in ('telefono','correo')),
  valor         text not null,                        -- normalizado (E.164 o correo en minúsculas)
  primary key (tipo, valor)
);

create table if not exists nucleo.cursos (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  consultora_id uuid not null references nucleo.consultoras(id),
  titulo        text not null,
  modalidad     text,                                 -- autogestivo | acompañado | en vivo (según el sistema de origen)
  activo        boolean not null default true,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id)
);

create table if not exists nucleo.ediciones (                -- = apertura del IPCIL = cohorte de la Academia
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  curso_id      uuid not null references nucleo.cursos(id),
  consultora_id uuid not null references nucleo.consultoras(id),
  nombre        text not null,
  inicia_en     timestamptz,
  termina_en    timestamptz,
  zona_horaria  text not null default 'America/Mexico_City',
  modalidad     text,
  precio_centavos integer not null default 0 check (precio_centavos >= 0),
  precio_sesion_centavos integer check (precio_sesion_centavos is null or precio_sesion_centavos >= 0),
  moneda        text not null default 'MXN',
  estado_catalogo text not null default 'draft',       -- draft | published | archived
  estado_apertura text not null default 'planned',     -- planned | open | running | closed | cancelled
  minimo_alumnos integer not null default 0,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id)
);

create table if not exists nucleo.sesiones (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  edicion_id    uuid not null references nucleo.ediciones(id),
  numero        integer not null,
  titulo        text not null,
  inicia_en     timestamptz not null,
  duracion_min  integer not null default 90,
  estado        text not null default 'scheduled',     -- scheduled | done | cancelled
  enlace        text,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id)
);

create table if not exists nucleo.pagos (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  referencia    text,
  consultora_id uuid not null references nucleo.consultoras(id),
  persona_id    uuid references nucleo.personas(id),
  curso_id      uuid references nucleo.cursos(id),
  edicion_id    uuid references nucleo.ediciones(id),
  sesion_id     uuid references nucleo.sesiones(id),   -- sólo pagos por sesión
  tipo          text not null default 'course' check (tipo in ('course','session')),
  plan          text not null default 'full' check (plan in ('full','per_session')),
  importe_centavos integer not null check (importe_centavos >= 0),
  moneda        text not null default 'MXN',
  metodo        text,                                  -- card | oxxo | transfer | spei
  estado        text not null,                         -- pending | review | paid | cancelled | expired | refunded
  proveedor_ref text,
  vendedor_ref  text,                                  -- id de usuario del sistema de origen
  creado_en     timestamptz,
  pagado_en     timestamptz,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id)
);

create table if not exists nucleo.inscripciones (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  persona_id    uuid references nucleo.personas(id),
  consultora_id uuid not null references nucleo.consultoras(id),
  curso_id      uuid references nucleo.cursos(id),
  edicion_id    uuid references nucleo.ediciones(id),
  pago_id       uuid references nucleo.pagos(id),
  estado        text not null default 'enrolled',      -- enrolled | cancelled
  plan          text not null default 'full' check (plan in ('full','per_session')),
  creada_en     timestamptz,
  cancelada_en  timestamptz,
  motivo_baja   text,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id)
);

create table if not exists nucleo.certificados (
  id            uuid primary key default gen_random_uuid(),
  origen        text not null default 'crm',
  origen_id     text not null,
  folio         text not null,                         -- IPCI-AAAA-NNNNN, único entre sistemas
  inscripcion_id uuid references nucleo.inscripciones(id),
  persona_id    uuid references nucleo.personas(id),
  consultora_id uuid not null references nucleo.consultoras(id),
  curso_id      uuid references nucleo.cursos(id),
  edicion_id    uuid references nucleo.ediciones(id),
  titular       text not null,
  estado        text not null default 'issued',        -- issued | revoked
  asistencia_pct integer,
  horas         integer,
  emitido_en    timestamptz,
  revocado_en   timestamptz,
  verificacion_url text,
  actualizado_en timestamptz not null default now(),
  unique (origen, origen_id),
  unique (folio)
);

-- Hechos del negocio tal como los publica cada sistema (una fila por evento recibido, idempotente por origen y seq).
create table if not exists nucleo.eventos (
  id            uuid primary key,                      -- id del evento en el sistema de origen
  origen        text not null,
  origen_seq    bigint not null,
  tipo          text not null,                         -- pago.confirmado, inscripcion.activada, apertura.abierta, certificado.emitido…
  consultora    text not null,                         -- clave de la consultora
  entidad_tipo  text not null,
  entidad_id    text not null,
  carga         jsonb not null default '{}'::jsonb,
  ocurrido_en   timestamptz not null,
  recibido_en   timestamptz not null default now(),
  unique (origen, origen_seq)
);
create index if not exists eventos_tipo on nucleo.eventos (tipo, ocurrido_en);
create index if not exists eventos_entidad on nucleo.eventos (entidad_tipo, entidad_id, ocurrido_en);

-- Orden de «upsert» al recibir un sobre del outbox: consultoras → personas (+identidades) → cursos → ediciones → sesiones
-- → pagos → inscripciones → certificados → eventos. Si el evento ya existe (origen, origen_seq) se responde 200 sin cambios.
