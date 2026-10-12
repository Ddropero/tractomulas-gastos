-- ============================================================
-- Centro de Control de gastos — FLOTA
-- Presupuestos / límites por categoría, vehículo o general (tope mensual).
-- El centro de control (GET /api/centro-control) consolida KPIs, alertas,
-- estado de presupuestos y tendencias; no requiere tablas extra salvo esta.
-- ============================================================

CREATE TABLE IF NOT EXISTS presupuestos (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ambito         TEXT NOT NULL,            -- 'categoria' | 'vehiculo' | 'general'
  referencia     TEXT,                     -- nombre categoría / placa vehículo / NULL si general
  monto          REAL NOT NULL,            -- tope mensual
  activo         INTEGER DEFAULT 1,
  notas          TEXT,
  creado_en      TEXT DEFAULT (datetime('now')),
  actualizado_en TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_presupuestos_ambito ON presupuestos(ambito, referencia);
