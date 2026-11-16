-- ============================================================
-- Piloto: inscripción, configuración de empresa y vinculación de Telegram
-- Idempotente. No modifica tablas existentes. Sin datos.
-- Solo CREATE TABLE / INDEX IF NOT EXISTS: aplicarlo en una base que ya tiene
-- las demás tablas no cambia nada de lo existente.
-- Las columnas que pueden faltar en una base vieja (vehiculos.telegram_chat_id y las dos de la guía
-- en config_empresa) las agrega config-empresa.js tras revisar PRAGMA table_info.
-- Las fechas quedan en UTC (datetime('now')), igual que el resto de la app.
-- ============================================================

-- Una sola empresa por instancia (id fijo = 1)
CREATE TABLE IF NOT EXISTS config_empresa (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  nombre          TEXT NOT NULL,
  documento_tipo  TEXT NOT NULL CHECK (documento_tipo IN ('NIT','CC')),
  documento       TEXT NOT NULL,
  correo          TEXT NOT NULL,
  celular         TEXT,
  conductor_nombre  TEXT,
  conductor_celular TEXT,
  transportadoras TEXT,                       -- arreglo JSON
  user_id         INTEGER,                    -- administrador creado en la inscripción
  creado_en       TEXT DEFAULT (datetime('now')),
  actualizado_en  TEXT DEFAULT (datetime('now')),
  -- Guía de primeros pasos (GET/POST /api/primeros-pasos). En una base creada antes de estas columnas
  -- las agrega asegurarEsquemaGuia() de config-empresa.js la primera vez que se abre la guía.
  guia_oculta          INTEGER NOT NULL DEFAULT 0,   -- 1 = el dueño ocultó la guía
  extractos_marcado_en TEXT,                         -- cuándo marcó que ya envió los extractos
  conductor_propio_en  TEXT                          -- cuándo marcó que él mismo maneja la mula (no hay chat de conductor)
);

-- Invitaciones de un solo uso (solo el hash del código)
CREATE TABLE IF NOT EXISTS invitaciones (
  codigo_hash  TEXT PRIMARY KEY,              -- SHA-256 en hexadecimal
  nota         TEXT,
  creada_en    TEXT DEFAULT (datetime('now')),
  expira_en    TEXT NOT NULL,                 -- 'YYYY-MM-DD HH:MM:SS' en UTC
  usada_en     TEXT,
  usada_por    INTEGER                        -- users.id
);

-- Intentos fallidos (límite por IP y global de la inscripción; códigos TOTP fallidos con ruta = 'totp')
CREATE TABLE IF NOT EXISTS intentos_inscripcion (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash    TEXT NOT NULL,                   -- SHA-256 de la IP (o del usuario para 'totp'), nunca la IP
  ruta       TEXT,                            -- 'validar' | 'inscripcion' | 'totp'
  creado_en  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intentos_ip    ON intentos_inscripcion(ip_hash, creado_en);
CREATE INDEX IF NOT EXISTS idx_intentos_fecha ON intentos_inscripcion(creado_en);

-- Chats de Telegram autorizados por vinculación (/start <código>)
CREATE TABLE IF NOT EXISTS telegram_chats (
  chat_id         TEXT PRIMARY KEY,
  rol             TEXT NOT NULL CHECK (rol IN ('dueno','conductor')),
  placa           TEXT,                       -- NULL = dueño sin vehículo fijo
  nombre          TEXT,
  tg_user_id      TEXT,
  tg_username     TEXT,
  activo          INTEGER NOT NULL DEFAULT 1,
  vinculado_en    TEXT DEFAULT (datetime('now')),
  acepto_datos_en TEXT                        -- /acepto del conductor
);
CREATE INDEX IF NOT EXISTS idx_tgchats_placa ON telegram_chats(placa);

-- Códigos de vinculación para /start (solo el hash)
CREATE TABLE IF NOT EXISTS telegram_vinculos (
  codigo_hash  TEXT PRIMARY KEY,
  rol          TEXT NOT NULL CHECK (rol IN ('dueno','conductor')),
  placa        TEXT,
  nombre       TEXT,
  creado_por   INTEGER,                       -- users.id
  creado_en    TEXT DEFAULT (datetime('now')),
  expira_en    TEXT NOT NULL,                 -- 'YYYY-MM-DD HH:MM:SS' en UTC
  usado_en     TEXT,
  chat_id      TEXT
);
CREATE INDEX IF NOT EXISTS idx_tgvinc_expira ON telegram_vinculos(expira_en);

-- Constancia de aceptaciones (Ley 1581 de 2012 y términos del piloto)
CREATE TABLE IF NOT EXISTS consentimientos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sujeto         TEXT NOT NULL CHECK (sujeto IN ('titular','conductor')),
  tipo           TEXT NOT NULL CHECK (tipo IN ('terminos_piloto','datos_1581')),
  version_texto  TEXT NOT NULL,
  user_id        INTEGER,
  chat_id        TEXT,
  nombre         TEXT,
  documento      TEXT,
  ip             TEXT,
  user_agent     TEXT,
  aceptado_en    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consent_user ON consentimientos(user_id);
CREATE INDEX IF NOT EXISTS idx_consent_chat ON consentimientos(chat_id);
