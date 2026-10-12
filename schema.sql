-- ============================================================
-- Tractomulas Gastos - D1 Schema
-- Vehículos: STT 115, STT 121, UPO 707
-- ============================================================

-- Vehículos
CREATE TABLE IF NOT EXISTS vehiculos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  placa       TEXT NOT NULL UNIQUE,
  nombre      TEXT NOT NULL,
  tipo        TEXT DEFAULT 'tractomula',
  activo      INTEGER DEFAULT 1,
  creado_en   TEXT DEFAULT (datetime('now'))
);

-- Proveedores conocidos
CREATE TABLE IF NOT EXISTS proveedores (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  nit             TEXT NOT NULL UNIQUE,
  nombre          TEXT NOT NULL,
  nombre_corto    TEXT,
  categoria_default TEXT,
  creado_en       TEXT DEFAULT (datetime('now'))
);

-- Categorías válidas
CREATE TABLE IF NOT EXISTS categorias (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre      TEXT NOT NULL UNIQUE,
  descripcion TEXT,
  deducible   INTEGER DEFAULT 1
);

-- Gastos (tabla principal)
CREATE TABLE IF NOT EXISTS gastos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  numero          INTEGER UNIQUE,
  fecha           TEXT NOT NULL,
  vehiculo        TEXT NOT NULL,
  proveedor_nit   TEXT,
  proveedor_nombre TEXT NOT NULL,
  numero_documento TEXT,
  concepto        TEXT NOT NULL,
  categoria       TEXT NOT NULL,
  valor_base      REAL DEFAULT 0,
  iva             REAL DEFAULT 0,
  inc             REAL DEFAULT 0,
  otros_impuestos REAL DEFAULT 0,
  total           REAL NOT NULL,
  es_nota_credito INTEGER DEFAULT 0,
  medio_pago      TEXT,
  referencia_pago TEXT,
  kilometraje     INTEGER,
  ruta            TEXT,
  archivo_r2      TEXT,
  usuario         TEXT DEFAULT 'david',
  estado          TEXT DEFAULT 'confirmado',
  notas           TEXT,
  creado_en       TEXT DEFAULT (datetime('now')),
  actualizado_en  TEXT DEFAULT (datetime('now')),

  FOREIGN KEY (categoria) REFERENCES categorias(nombre)
);

-- Índices
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_vehiculo ON gastos(vehiculo);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos(categoria);
CREATE INDEX IF NOT EXISTS idx_gastos_proveedor ON gastos(proveedor_nit);
CREATE INDEX IF NOT EXISTS idx_gastos_numero_doc ON gastos(numero_documento);

-- ============================================================
-- Datos iniciales — vehículos
-- ============================================================
INSERT OR IGNORE INTO vehiculos (placa, nombre) VALUES
  ('STT115', 'STT 115'),
  ('STT121', 'STT 121'),
  ('UPO707', 'UPO 707');

-- ============================================================
-- Datos iniciales — categorías
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

-- ============================================================
-- Datos iniciales — proveedores frecuentes
-- ============================================================
INSERT OR IGNORE INTO proveedores (nit, nombre, nombre_corto, categoria_default) VALUES
  ('800155413-6', 'Biomax S.A.',                    'Biomax',         'Combustible'),
  ('860002552-9', 'Terpel S.A.',                    'Terpel',         'Combustible'),
  ('811009788-8', 'Distracom S.A.',                 'Distracom',      'Combustible'),
  ('900078103-0', 'Combustibles H&R Ltda.',         'DH Galerías',    'Combustible'),
  ('800197268-3', 'Concesión Ruta del Sol',         'Ruta del Sol',   'Peajes'),
  ('900395629-1', 'ANI Peajes',                     'ANI Peajes',     'Peajes'),
  ('900568774-5', 'K-Saval Energy SAS BIC',         'K-Saval',        'Combustible');
