// export-contadora.js — Generador de base contable consolidada para la contadora.
// JS puro de Cloudflare Workers: sin dependencias, sin require/import de paquetes.
//
// CSV: UTF-8 con BOM, delimitador ';' (locale Colombia), saltos de línea CRLF (\r\n).
// Números enteros sin separador de miles; punto decimal solo si hay decimales.
// Textos escapados: si contienen ';' o '"' se envuelven en comillas dobles y las
// comillas internas se duplican ("").

const DELIM = ';';
const CRLF = '\r\n';
const BOM = '﻿';

// Formatea un número: entero sin separador de miles, decimal con punto solo si aplica.
function num(v) {
  const n = Number(v);
  if (!isFinite(n) || v === null || v === undefined || v === '') return '0';
  if (Number.isInteger(n)) return String(n);
  // Recorta ceros de cola pero conserva decimales significativos.
  return String(parseFloat(n.toFixed(2)));
}

// Escapa un texto para CSV: envuelve en comillas si contiene ; " salto de línea.
function txt(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.indexOf(DELIM) !== -1 || s.indexOf('"') !== -1 || s.indexOf('\n') !== -1 || s.indexOf('\r') !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Une celdas en una fila CSV.
function row(cells) {
  return cells.join(DELIM);
}

export function generarReporteContadora(viajes, gastos, mes, emisor) {
  const vs = Array.isArray(viajes) ? viajes : [];
  const gs = Array.isArray(gastos) ? gastos : [];
  const emi = emisor || {};
  const nombre = emi.nombre || '(configurar EMISOR_NOMBRE)';
  const nit = emi.nit || '(configurar EMISOR_NIT)';

  // Total de gastos por viaje_id (para Total Gastos / Utilidad de cada viaje).
  const gastosPorViaje = {};
  for (const g of gs) {
    if (g && g.viaje_id !== null && g.viaje_id !== undefined && g.viaje_id !== '') {
      const k = String(g.viaje_id);
      gastosPorViaje[k] = (gastosPorViaje[k] || 0) + (Number(g.total) || 0);
    }
  }

  const lines = [];

  // Línea título.
  lines.push(txt('BASE CONTABLE FLOTA - ' + nombre + ' NIT ' + nit + ' - ' + mes));
  lines.push('');

  // ===== Sección INGRESOS / VIAJES =====
  lines.push(txt('INGRESOS / VIAJES'));
  lines.push(row([
    'Numero', 'Fecha', 'Manifiesto', 'Vehiculo', 'Cliente', 'NIT Cliente',
    'Origen', 'Destino', 'Valor Flete', 'Retefuente', 'Valor Neto', 'Anticipo',
    'Saldo a Cobrar', 'Estado Cobro', 'Total Gastos', 'Utilidad',
    'Estado Factura', 'No Factura',
  ]));

  let tFlete = 0, tRetefuente = 0, tNeto = 0, tAnticipo = 0, tSaldo = 0,
    tGastosViaje = 0, tUtilidad = 0;

  for (const v of vs) {
    const flete = Number(v.valor_flete) || 0;
    const totGastos = gastosPorViaje[String(v.id)] || 0;
    const utilidad = flete - totGastos;

    tFlete += flete;
    tRetefuente += Number(v.retefuente) || 0;
    tNeto += Number(v.valor_neto) || 0;
    tAnticipo += Number(v.anticipo) || 0;
    tSaldo += Number(v.saldo_a_cobrar) || 0;
    tGastosViaje += totGastos;
    tUtilidad += utilidad;

    lines.push(row([
      txt(v.numero),
      txt(v.fecha_viaje),
      txt(v.numero_manifiesto),
      txt(v.vehiculo),
      txt(v.empresa_carga),
      txt(v.empresa_carga_nit),
      txt(v.origen),
      txt(v.destino),
      num(flete),
      num(v.retefuente),
      num(v.valor_neto),
      num(v.anticipo),
      num(v.saldo_a_cobrar),
      txt(v.estado_cobro),
      num(totGastos),
      num(utilidad),
      txt(v.estado_factura),
      txt(v.numero_factura),
    ]));
  }

  // Fila TOTALES de ingresos.
  lines.push(row([
    txt('TOTALES'), '', '', '', '', '', '', '',
    num(tFlete), num(tRetefuente), num(tNeto), num(tAnticipo),
    num(tSaldo), '', num(tGastosViaje), num(tUtilidad), '', '',
  ]));

  // Línea en blanco.
  lines.push('');

  // ===== Sección GASTOS DETALLE =====
  lines.push(txt('GASTOS DETALLE'));
  lines.push(row([
    'Numero', 'Fecha', 'Manifiesto/Viaje', 'Vehiculo', 'Proveedor', 'NIT',
    'Concepto', 'Categoria', 'Valor Base', 'IVA', 'Total', 'Medio Pago',
  ]));

  let gBase = 0, gIva = 0, gTotal = 0;

  for (const g of gs) {
    gBase += Number(g.valor_base) || 0;
    gIva += Number(g.iva) || 0;
    gTotal += Number(g.total) || 0;

    // Manifiesto/Viaje: usa numero_manifiesto si vino enlazado, si no viaje_id.
    const manifiestoViaje = (g.numero_manifiesto !== null && g.numero_manifiesto !== undefined && g.numero_manifiesto !== '')
      ? g.numero_manifiesto
      : (g.viaje_id !== null && g.viaje_id !== undefined && g.viaje_id !== '' ? g.viaje_id : '');

    lines.push(row([
      txt(g.numero),
      txt(g.fecha),
      txt(manifiestoViaje),
      txt(g.vehiculo),
      txt(g.proveedor_nombre),
      txt(g.proveedor_nit),
      txt(g.concepto),
      txt(g.categoria),
      num(g.valor_base),
      num(g.iva),
      num(g.total),
      txt(g.medio_pago),
    ]));
  }

  // Fila TOTALES de gastos.
  lines.push(row([
    txt('TOTALES'), '', '', '', '', '', '', '',
    num(gBase), num(gIva), num(gTotal), '',
  ]));

  const content = BOM + lines.join(CRLF) + CRLF;

  return {
    filename: 'contadora-flota-' + mes + '.csv',
    content,
    contentType: 'text/csv; charset=utf-8',
  };
}
