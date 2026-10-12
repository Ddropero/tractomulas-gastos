// ============================================================
// COCICP Gastos — Detección de gastos recurrentes mensuales
// Exporta RECURRENTES y checkRecurrentes(db, mes, anio)
// ============================================================

export const RECURRENTES = [
  {
    nombre: 'Liceo Francés',
    nit: '901423905',
    frecuencia: 'mensual',
    categoria: 'Educación hijos'
  },
  {
    nombre: 'Ballet Pavlova',
    nit: '830009217',
    frecuencia: 'mensual',
    categoria: 'Educación hijos'
  },
  {
    nombre: 'Bus escolar',
    nit: '901023168',
    frecuencia: 'mensual',
    categoria: 'Educación hijos'
  },
  {
    nombre: 'Acción Fiduciaria',
    nit: '800155413',
    frecuencia: 'mensual',
    categoria: 'Vivienda'
  },
  {
    nombre: 'miplanilla (Seg. Social)',
    nit: '9998600669427',
    frecuencia: 'mensual',
    categoria: 'Seguridad Social'
  },
  {
    nombre: 'Laura Anaya',
    nit: '902029628',
    frecuencia: 'mensual',
    categoria: 'Honorarios Médicos'
  }
];

/**
 * Consulta D1 para un mes/año y determina cuáles recurrentes
 * tienen al menos un registro y cuáles faltan.
 *
 * @param {D1Database} db  — binding D1
 * @param {number} mes     — 1..12
 * @param {number} anio    — ej. 2026
 * @returns {{ ok: Array, faltantes: Array, mes: number, anio: number }}
 */
export async function checkRecurrentes(db, mes, anio) {
  const mm = String(mes).padStart(2, '0');
  const desde = `${anio}-${mm}-01`;
  const hasta = `${anio}-${mm}-31`; // D1 BETWEEN is inclusive; day 31 is safe

  // Traer todos los gastos del mes con NIT (sin dígito verificación)
  const { results } = await db.prepare(
    `SELECT proveedor_nit, proveedor_nombre, total, fecha
     FROM gastos
     WHERE fecha BETWEEN ? AND ?`
  ).bind(desde, hasta).all();

  // Normalizar NITs encontrados: quitar guión + dígito verificación
  const nitsEncontrados = new Set(
    results.map(r => (r.proveedor_nit || '').replace(/\D/g, '').replace(/\d$/, ''))
  );

  // También guardar el NIT completo para fallback
  const nitsCompletos = new Set(
    results.map(r => (r.proveedor_nit || '').replace(/\D/g, ''))
  );

  const ok = [];
  const faltantes = [];

  for (const rec of RECURRENTES) {
    const nitBase = rec.nit.replace(/\D/g, '');
    const encontrado = nitsEncontrados.has(nitBase) || nitsCompletos.has(nitBase);

    if (encontrado) {
      // Buscar el registro que matcheó para incluir info
      const registro = results.find(r => {
        const n = (r.proveedor_nit || '').replace(/\D/g, '');
        return n === nitBase || n.startsWith(nitBase);
      });
      ok.push({
        ...rec,
        registro: registro
          ? { total: registro.total, fecha: registro.fecha, proveedor_nombre: registro.proveedor_nombre }
          : null
      });
    } else {
      faltantes.push(rec);
    }
  }

  return { ok, faltantes, mes, anio };
}
