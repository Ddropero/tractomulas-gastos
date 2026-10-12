-- ============================================================
-- Schema módulo VIAJES / INGRESOS (manifiestos de carga) — FLOTA
-- Aplicado en D1 tractomulas-gastos (549d0f50-7678-4b55-b9e1-253b315e6dcc)
-- Un VIAJE = un manifiesto electrónico de carga = un INGRESO.
-- Los GASTOS se enlazan al viaje vía gastos.viaje_id.
-- ============================================================

CREATE TABLE IF NOT EXISTS viajes (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  numero            INTEGER UNIQUE,            -- consecutivo interno
  numero_manifiesto TEXT,                      -- N° del manifiesto OPL (ej. 791199)
  fecha_viaje       TEXT NOT NULL,             -- YYYY-MM-DD
  vehiculo          TEXT NOT NULL,             -- STT115 | STT121 | UPO707
  conductor         TEXT,
  origen            TEXT,                      -- Origen Viaje
  destino           TEXT,                      -- Destino Viaje
  empresa_carga     TEXT,                      -- cliente / titular del manifiesto (ej. OPL CARGA SAS)
  empresa_carga_nit TEXT,
  remitente         TEXT,
  destinatario      TEXT,
  mercancia         TEXT,
  peso_kg           REAL,
  valor_flete       REAL DEFAULT 0,            -- VALOR TOTAL VIAJE (ingreso)
  retefuente        REAL DEFAULT 0,            -- RETENCION EN LA FUENTE
  reteica           REAL DEFAULT 0,
  otras_retenciones REAL DEFAULT 0,
  valor_neto        REAL DEFAULT 0,            -- VALOR NETO A PAGAR
  anticipo          REAL DEFAULT 0,            -- VALOR ANTICIPO
  saldo_a_cobrar    REAL DEFAULT 0,            -- SALDO A PAGAR / lo que falta consignar
  -- conciliación del cobro
  estado_cobro      TEXT DEFAULT 'pendiente',  -- pendiente | cobrado | parcial
  valor_cobrado     REAL DEFAULT 0,
  fecha_cobro       TEXT,
  -- facturación electrónica (Aliaddo)
  estado_factura    TEXT DEFAULT 'pendiente',  -- pendiente | facturado
  numero_factura    TEXT,
  fecha_factura     TEXT,
  -- archivos / meta
  archivo_r2        TEXT,                      -- manifiesto en R2
  usuario           TEXT DEFAULT 'andrea',
  estado            TEXT DEFAULT 'confirmado', -- confirmado | revision
  notas             TEXT,
  creado_en         TEXT DEFAULT (datetime('now')),
  actualizado_en    TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_viajes_fecha      ON viajes(fecha_viaje);
CREATE INDEX IF NOT EXISTS idx_viajes_vehiculo   ON viajes(vehiculo);
CREATE INDEX IF NOT EXISTS idx_viajes_manifiesto ON viajes(numero_manifiesto);

-- Enlace gasto -> viaje (utilidad del viaje = valor_flete - SUM(gastos del viaje))
ALTER TABLE gastos ADD COLUMN viaje_id INTEGER;

-- Cruce DIAN -> documento equivalente (facturas no electrónicas)
ALTER TABLE gastos ADD COLUMN es_electronica INTEGER;   -- NULL=sin cruzar, 1=tiene FE, 0=requiere doc equivalente
ALTER TABLE gastos ADD COLUMN doc_equivalente TEXT;     -- N° del documento soporte generado en Aliaddo

-- Auto-enlace gasto<->viaje por álbum de Telegram (media_group_id compartido en un mismo envío)
ALTER TABLE gastos ADD COLUMN media_group_id TEXT;
ALTER TABLE viajes ADD COLUMN media_group_id TEXT;

-- ============================================================
-- Auditoría de planilla mensual del conductor (lado a lado vs sistema)
-- La columna "%" de la planilla = comisión del conductor.
-- ============================================================
ALTER TABLE viajes ADD COLUMN comision_conductor REAL DEFAULT 0;  -- lado SISTEMA

-- Lo DECLARADO por el conductor en su planilla mensual (lado DECLARADO)
CREATE TABLE IF NOT EXISTS planilla_auditoria (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  vehiculo           TEXT NOT NULL,
  mes                TEXT NOT NULL,            -- YYYY-MM
  fecha              TEXT,
  destino            TEXT,
  empresa_carga      TEXT,
  numero_manifiesto  TEXT,
  valor_flete        REAL DEFAULT 0,
  anticipo           REAL DEFAULT 0,
  gastos             REAL DEFAULT 0,
  comision_conductor REAL DEFAULT 0,
  saldo_a_cobrar     REAL DEFAULT 0,
  es_cierre          INTEGER DEFAULT 0,        -- 1 = fila de cierre (devolución/le debo/me debe)
  concepto_cierre    TEXT,
  archivo_r2         TEXT,
  usuario            TEXT DEFAULT 'andrea',
  notas              TEXT,
  creado_en          TEXT DEFAULT (datetime('now')),
  actualizado_en     TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_planilla_veh_mes     ON planilla_auditoria(vehiculo, mes);
CREATE INDEX IF NOT EXISTS idx_planilla_manifiesto  ON planilla_auditoria(numero_manifiesto);
