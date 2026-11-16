-- ============================================================
-- Esquema base CONSOLIDADO para una base NUEVA (instancia de piloto)
-- NO aplicar en producción. Solo CREATE TABLE / INDEX IF NOT EXISTS, sin ALTER.
--
-- Por qué existe: schema.sql + schema-viajes.sql + schema-auth.sql + schema-centro-control.sql
-- no reproducen la base real (hay columnas agregadas a mano y tablas que no están en ningún .sql).
-- Las columnas salen de los INSERT / UPDATE / SELECT de worker.js, telegram.js y los agentes.
-- ANTES del despliegue real hay que contrastarlo con la estructura de producción
-- (wrangler d1 export ... --no-data) y corregir lo que falte.
--
-- Diferencias deliberadas con los .sql originales:
--   - vehiculos: con telegram_chat_id y SIN semilla de placas (las crea la inscripción).
--   - gastos.vehiculo sin NOT NULL (el bot guarda null cuando no se sabe el vehículo).
--   - gastos.usuario / viajes.usuario / planilla_auditoria.usuario sin valor por defecto con nombres propios.
--   - proveedores: solo los genéricos de combustible y peajes.
-- Después de este archivo se aplica schema-piloto.sql.
-- Tablas que el código crea solo cuando las necesita (no van aquí): ocr_pendientes, facturas_email,
-- facturas_manuales, documentos_soporte_manuales.
-- ============================================================

-- ── Vehículos (sin datos: los crea la inscripción) ──
CREATE TABLE IF NOT EXISTS vehiculos (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  placa            TEXT NOT NULL UNIQUE,
  nombre           TEXT NOT NULL,
  tipo             TEXT DEFAULT 'tractomula',
  activo           INTEGER DEFAULT 1,
  telegram_chat_id TEXT,
  creado_en        TEXT DEFAULT (datetime('now'))
);

-- ── Proveedores (con los datos bancarios que usa el pago masivo) ──
CREATE TABLE IF NOT EXISTS proveedores (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  nit                      TEXT NOT NULL UNIQUE,
  nombre                   TEXT NOT NULL,
  nombre_corto             TEXT,
  categoria_default        TEXT,
  banco_finandina          TEXT,
  tipo_cuenta              TEXT,
  numero_cuenta            TEXT,
  tipo_documento_titular   TEXT,
  numero_documento_titular TEXT,
  nombre_titular           TEXT,
  apellido_titular         TEXT,
  razon_social_titular     TEXT,
  email_notificacion       TEXT,
  creado_en                TEXT DEFAULT (datetime('now'))
);

-- ── Categorías ──
CREATE TABLE IF NOT EXISTS categorias (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  deducible   INTEGER DEFAULT 1
);

-- ── Gastos ──
CREATE TABLE IF NOT EXISTS gastos (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  numero             INTEGER UNIQUE,
  fecha              TEXT NOT NULL,
  vehiculo           TEXT,
  proveedor_nit      TEXT,
  proveedor_nombre   TEXT NOT NULL,
  numero_documento   TEXT,
  concepto           TEXT NOT NULL,
  categoria          TEXT NOT NULL,
  valor_base         REAL DEFAULT 0,
  iva                REAL DEFAULT 0,
  inc                REAL DEFAULT 0,
  otros_impuestos    REAL DEFAULT 0,
  total              REAL NOT NULL,
  es_nota_credito    INTEGER DEFAULT 0,
  medio_pago         TEXT,
  referencia_pago    TEXT,
  kilometraje        INTEGER,
  ruta               TEXT,
  archivo_r2         TEXT,
  usuario            TEXT,
  estado             TEXT DEFAULT 'confirmado',
  notas              TEXT,
  viaje_id           INTEGER,
  es_electronica     INTEGER,            -- NULL = sin cruzar, 1 = tiene factura electrónica, 0 = requiere documento equivalente
  doc_equivalente    TEXT,
  media_group_id     TEXT,
  es_recurrente      INTEGER DEFAULT 0,
  pagado_via         TEXT,
  fecha_pago_masivo  TEXT,
  archivo_dispersion TEXT,
  creado_en          TEXT DEFAULT (datetime('now')),
  actualizado_en     TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (categoria) REFERENCES categorias(nombre)
);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha      ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_vehiculo   ON gastos(vehiculo);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria  ON gastos(categoria);
CREATE INDEX IF NOT EXISTS idx_gastos_proveedor  ON gastos(proveedor_nit);
CREATE INDEX IF NOT EXISTS idx_gastos_numero_doc ON gastos(numero_documento);
CREATE INDEX IF NOT EXISTS idx_gastos_viaje      ON gastos(viaje_id);
CREATE INDEX IF NOT EXISTS idx_gastos_album      ON gastos(media_group_id);

-- ── Viajes / ingresos (un manifiesto = un viaje) ──
CREATE TABLE IF NOT EXISTS viajes (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  numero             INTEGER UNIQUE,
  numero_manifiesto  TEXT,
  fecha_viaje        TEXT NOT NULL,
  vehiculo           TEXT NOT NULL,
  conductor          TEXT,
  origen             TEXT,
  destino            TEXT,
  empresa_carga      TEXT,
  empresa_carga_nit  TEXT,
  remitente          TEXT,
  destinatario       TEXT,
  mercancia          TEXT,
  peso_kg            REAL,
  valor_flete        REAL DEFAULT 0,
  retefuente         REAL DEFAULT 0,
  reteica            REAL DEFAULT 0,
  otras_retenciones  REAL DEFAULT 0,
  valor_neto         REAL DEFAULT 0,
  anticipo           REAL DEFAULT 0,
  saldo_a_cobrar     REAL DEFAULT 0,
  estado_cobro       TEXT DEFAULT 'pendiente',
  valor_cobrado      REAL DEFAULT 0,
  fecha_cobro        TEXT,
  estado_factura     TEXT DEFAULT 'pendiente',
  numero_factura     TEXT,
  fecha_factura      TEXT,
  archivo_r2         TEXT,
  usuario            TEXT,
  estado             TEXT DEFAULT 'confirmado',
  notas              TEXT,
  media_group_id     TEXT,
  comision_conductor REAL DEFAULT 0,
  creado_en          TEXT DEFAULT (datetime('now')),
  actualizado_en     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_viajes_fecha      ON viajes(fecha_viaje);
CREATE INDEX IF NOT EXISTS idx_viajes_vehiculo   ON viajes(vehiculo);
CREATE INDEX IF NOT EXISTS idx_viajes_manifiesto ON viajes(numero_manifiesto);
CREATE INDEX IF NOT EXISTS idx_viajes_album      ON viajes(media_group_id);

-- ── Auditoría de la planilla mensual del conductor ──
CREATE TABLE IF NOT EXISTS planilla_auditoria (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  vehiculo           TEXT NOT NULL,
  mes                TEXT NOT NULL,
  fecha              TEXT,
  destino            TEXT,
  empresa_carga      TEXT,
  numero_manifiesto  TEXT,
  valor_flete        REAL DEFAULT 0,
  anticipo           REAL DEFAULT 0,
  gastos             REAL DEFAULT 0,
  comision_conductor REAL DEFAULT 0,
  saldo_a_cobrar     REAL DEFAULT 0,
  es_cierre          INTEGER DEFAULT 0,
  concepto_cierre    TEXT,
  archivo_r2         TEXT,
  usuario            TEXT,
  notas              TEXT,
  creado_en          TEXT DEFAULT (datetime('now')),
  actualizado_en     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planilla_veh_mes    ON planilla_auditoria(vehiculo, mes);
CREATE INDEX IF NOT EXISTS idx_planilla_manifiesto ON planilla_auditoria(numero_manifiesto);

-- ── Usuarios y sesiones ──
CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  totp_secret    TEXT,
  totp_verified  INTEGER DEFAULT 0,
  nombre         TEXT,
  rol            TEXT DEFAULT 'admin',
  activo         INTEGER DEFAULT 1,
  creado_en      TEXT DEFAULT (datetime('now')),
  ultimo_login   TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  tipo         TEXT DEFAULT 'full',
  expires_at   TEXT NOT NULL,
  creado_en    TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);

-- ── Presupuestos (centro de control) ──
CREATE TABLE IF NOT EXISTS presupuestos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ambito         TEXT NOT NULL,
  referencia     TEXT,
  monto          REAL NOT NULL,
  activo         INTEGER DEFAULT 1,
  notas          TEXT,
  creado_en      TEXT DEFAULT (datetime('now')),
  actualizado_en TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_presupuestos_ambito ON presupuestos(ambito, referencia);

-- ── Obligaciones (pagos recurrentes). No está en ningún .sql: columnas deducidas de worker.js ──
CREATE TABLE IF NOT EXISTS obligaciones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre           TEXT NOT NULL,
  descripcion      TEXT,
  tipo             TEXT DEFAULT 'empresa',
  categoria        TEXT,
  proveedor_nit    TEXT,
  proveedor_nombre TEXT,
  frecuencia       TEXT DEFAULT 'mensual',
  dia_limite       INTEGER,
  valor_estimado   REAL,
  medio_pago       TEXT,
  activo           INTEGER DEFAULT 1,
  notas            TEXT,
  creado_en        TEXT DEFAULT (datetime('now'))
);

-- ── Dispersiones (archivos de pago masivo). Columnas deducidas de worker.js; función apagada en el piloto ──
CREATE TABLE IF NOT EXISTS dispersiones (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  identificacion  INTEGER,
  fecha_pago      TEXT,
  cuenta_origen   TEXT,
  tipo_origen     TEXT,
  total_registros INTEGER,
  total_valor     REAL,
  archivo_nombre  TEXT,
  gastos_ids      TEXT,
  creado_en       TEXT DEFAULT (datetime('now'))
);

-- ── Terceros importados del proveedor de facturación. Columnas deducidas de worker.js; función apagada en el piloto ──
CREATE TABLE IF NOT EXISTS terceros (
  aliaddo_id     TEXT PRIMARY KEY,
  identificacion TEXT,
  nombre         TEXT,
  tipo           TEXT,
  email          TEXT,
  ciudad         TEXT,
  actualizado_en TEXT
);

-- ============================================================
-- Datos iniciales genéricos del sector (ninguno de una empresa en particular)
-- ============================================================
INSERT OR IGNORE INTO categorias (nombre, descripcion, deducible) VALUES
  ('Combustible',           'ACPM / Diésel',                          1),
  ('Peajes',                'Peajes en ruta',                         1),
  ('Llantas',               'Compra y reparación de llantas',         1),
  ('Mantenimiento',         'Mantenimiento preventivo y correctivo',  1),
  ('Repuestos',             'Autopartes y repuestos',                 1),
  ('Aceites y lubricantes', 'Cambios de aceite, filtros, lubricantes',1),
  ('Lavado',                'Lavado y engrase',                       1),
  ('Parqueadero',           'Parqueadero y patios',                   1),
  ('Seguro',                'SOAT, póliza todo riesgo, RCE',          1),
  ('Impuestos',             'Impuesto vehicular, rodamiento',         0),
  ('Tecnomecánica',         'Revisión técnico-mecánica',              1),
  ('GPS / Tecnología',      'Rastreo, equipos electrónicos',          1),
  ('Viáticos conductor',    'Alimentación y hospedaje del conductor', 1),
  ('Documentos',            'Permisos, planillas, manifiestos',       1),
  ('Multas',                'Comparendos y multas de tránsito',       0),
  ('Báscula',               'Pesaje en báscula',                      1),
  ('Cargue / Descargue',    'Servicios de cargue y descargue',        1),
  ('Administración',        'Gastos administrativos del vehículo',    1),
  ('Misceláneos',           'Sin categoría clara',                    0);

INSERT OR IGNORE INTO proveedores (nit, nombre, nombre_corto, categoria_default) VALUES
  ('800155413-6', 'Biomax S.A.',                    'Biomax',         'Combustible'),
  ('860002552-9', 'Terpel S.A.',                    'Terpel',         'Combustible'),
  ('811009788-8', 'Distracom S.A.',                 'Distracom',      'Combustible'),
  ('900078103-0', 'Combustibles H&R Ltda.',         'DH Galerías',    'Combustible'),
  ('800197268-3', 'Concesión Ruta del Sol',         'Ruta del Sol',   'Peajes'),
  ('900395629-1', 'ANI Peajes',                     'ANI Peajes',     'Peajes'),
  ('900568774-5', 'K-Saval Energy SAS BIC',         'K-Saval',        'Combustible');
