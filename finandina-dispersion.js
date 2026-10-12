/**
 * Finandina — Generador de archivo plano para pagos masivos (dispersión)
 * Portado de empleados/src/lib/finandina-dispersion.ts (Cloudflare Worker compatible)
 * ─────────────────────────────────────────────────────────────────────────
 * Spec: Instructivo Banca Empresas v3.2 + macro oficial ARCHIVO-MACRO-DISPERSION.xlsx
 *
 *   TIPO 1 (cabecera, 185 chars)
 *   TIPO 2 (detalle,  258 chars)
 *   TIPO 3 (cierre,   185 chars)
 *
 * Líneas separadas por \r\n. ASCII Latin1.
 */

// ─── Catálogo oficial de bancos (códigos ACH) ─────────────────────────────
export const BANCOS_FINANDINA = {
  'BANCO DE LA REPUBLICA': 0,
  'BANCO DE BOGOTA': 1,
  'BANCO POPULAR': 2,
  'ITAÚ CORPBANCA COLOMBIA SA': 6,
  'BANCOLOMBIA SA': 7,
  'CITIBANK COLOMBIA': 9,
  'GNBSUDAMERIS SA': 12,
  'BBVA COLOMBIA': 13,
  'COLPATRIA': 19,
  'BANCO DE OCCIDENTE': 23,
  'BANCO CAJA SOCIAL - BCSC SA': 32,
  'BANCO AGRARIO DE COLOMBIA SA': 40,
  'BANCO DAVIVIENDA': 51,
  'BANCO AV VILLAS': 52,
  'BANCO W SA': 53,
  'BANCO CREDIFINANCIERA SACF': 58,
  'BANCAMIA': 59,
  'BANCO PICHINCHA SA': 60,
  'BANCOOMEVA': 61,
  'CMR FALABELLA SA': 62,
  'BANCO FINANDINA SA': 63,
  'BANCO SANTANDER DE NEGOCIOS COLOMBIA SA': 65,
  'BANCO COOPERATIVO COOPCENTRAL': 66,
  'BANCO COMPARTIR SA': 67,
  'BANCO SERFINANZA SA': 69,
};

// Mapeo: nombre amigable → nombre oficial Finandina
export const BANCO_A_FINANDINA = {
  'Banco Finandina':       'BANCO FINANDINA SA',
  'Bancolombia':           'BANCOLOMBIA SA',
  'Davivienda':            'BANCO DAVIVIENDA',
  'BBVA':                  'BBVA COLOMBIA',
  'Banco de Bogota':       'BANCO DE BOGOTA',
  'Banco de Occidente':    'BANCO DE OCCIDENTE',
  'Banco Popular':         'BANCO POPULAR',
  'Banco Agrario':         'BANCO AGRARIO DE COLOMBIA SA',
  'Scotiabank Colpatria':  'COLPATRIA',
  'Itau':                  'ITAÚ CORPBANCA COLOMBIA SA',
  'Banco AV Villas':       'BANCO AV VILLAS',
  'Banco Caja Social':     'BANCO CAJA SOCIAL - BCSC SA',
  'Banco Falabella':       'CMR FALABELLA SA',
  'Banco GNB Sudameris':   'GNBSUDAMERIS SA',
  'Banco Pichincha':       'BANCO PICHINCHA SA',
  'Banco Serfinanza':      'BANCO SERFINANZA SA',
  'Banco W':               'BANCO W SA',
  'Bancoomeva':            'BANCOOMEVA',
  'Citibank':              'CITIBANK COLOMBIA',
};

const TIPO_ORIGEN_CODE = { ahorros: '1', corriente: '6' };

// ─── Helpers ──────────────────────────────────────────────────────────────
function normalizarASCII(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/Ñ/g, 'N')
    .replace(/ñ/g, 'n')
    .replace(/[^\x20-\x7E]/g, '')
    .toUpperCase();
}

function padLeftSpace(s, len) {
  if (s.length > len) throw new Error(`Valor "${s}" excede ${len} chars`);
  return ' '.repeat(len - s.length) + s;
}
function padRightSpace(s, len) {
  if (s.length > len) throw new Error(`Valor "${s}" excede ${len} chars`);
  return s + ' '.repeat(len - s.length);
}
function padLeftZero(value, len) {
  const s = String(value);
  if (s.length > len) throw new Error(`Número "${s}" excede ${len} dígitos`);
  return '0'.repeat(len - s.length) + s;
}
function formatFechaYYYYMMDD(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const yyyy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yyyy}${mm}${dd}`;
}

// ─── Líneas ───────────────────────────────────────────────────────────────
function generarLineaTipo1(c) {
  if (c.identificacionArchivo < 1 || c.identificacionArchivo > 999999) {
    throw new Error('identificacionArchivo debe estar entre 1 y 999999');
  }
  if (!/^\d+$/.test(c.cuentaOrigen)) {
    throw new Error('cuentaOrigen debe contener sólo dígitos');
  }
  const linea =
    '1' +
    '0000' +
    formatFechaYYYYMMDD(c.fechaPago) +
    padLeftZero(c.identificacionArchivo, 6) +
    TIPO_ORIGEN_CODE[c.tipoOrigen] +
    padLeftZero(c.cuentaOrigen, 10) +
    '0'.repeat(155);
  if (linea.length !== 185) throw new Error(`TIPO 1 longitud inválida: ${linea.length}`);
  return linea;
}

function generarLineaTipo2(b, consecutivo) {
  if (consecutivo < 1 || consecutivo > 9998) {
    throw new Error('consecutivo de detalle debe estar entre 1 y 9998');
  }
  if (!Number.isInteger(b.valor) || b.valor <= 0) {
    throw new Error(`valor inválido para ${b.identificacion}: ${b.valor}`);
  }
  if (!/^\d+$/.test(b.identificacion)) {
    throw new Error(`identificación debe ser sólo dígitos: "${b.identificacion}"`);
  }
  if (!/^\d+$/.test(b.cuentaDestino)) {
    throw new Error(`cuentaDestino debe ser sólo dígitos: "${b.cuentaDestino}"`);
  }
  if (!(b.banco in BANCOS_FINANDINA)) {
    throw new Error(`Banco no soportado: "${b.banco}"`);
  }

  const isPJ = b.tipoIdentificacion === 'NIT';
  if (isPJ && !b.razonSocial) throw new Error('NIT requiere razonSocial');
  if (!isPJ && (!b.nombre || !b.apellido)) {
    throw new Error(`PN (${b.tipoIdentificacion}) requiere nombre y apellido`);
  }

  const codigoBanco = BANCOS_FINANDINA[b.banco];
  const partes = [];
  partes.push('2');
  partes.push(padLeftZero(consecutivo, 4));
  partes.push(padLeftSpace(b.tipoIdentificacion, 3));
  partes.push(padLeftZero(b.identificacion, 11));

  if (isPJ) {
    partes.push(padRightSpace(normalizarASCII(b.razonSocial), 140));
  } else {
    partes.push(padRightSpace(normalizarASCII(b.nombre), 70));
    partes.push(padRightSpace(normalizarASCII(b.apellido), 70));
  }

  partes.push(padRightSpace(b.cuentaDestino, 17));
  partes.push(TIPO_ORIGEN_CODE[b.tipoCuentaDestino]);
  partes.push(padLeftZero(codigoBanco, 4));
  partes.push(padLeftZero(b.valor, 15) + '00');
  partes.push(padRightSpace(normalizarASCII(b.referencia1 ?? 'NULL'), 30));
  partes.push(padRightSpace(normalizarASCII(b.referencia2 ?? 'NULL'), 30));

  const linea = partes.join('');
  if (linea.length !== 258) {
    throw new Error(`TIPO 2 longitud inválida para ${b.identificacion}: ${linea.length}`);
  }
  return linea;
}

function generarLineaTipo3(totalRegistros, totalValor) {
  if (totalRegistros < 1 || totalRegistros > 9998) {
    throw new Error(`totalRegistros fuera de rango: ${totalRegistros}`);
  }
  const linea =
    '3' +
    '9999' +
    padLeftZero(totalRegistros, 4) +
    padLeftZero(totalValor, 15) +
    '00' +
    '0'.repeat(159);
  if (linea.length !== 185) throw new Error(`TIPO 3 longitud inválida: ${linea.length}`);
  return linea;
}

// ─── API pública ──────────────────────────────────────────────────────────
export function generarArchivoDispersion(cabecera, beneficiarios) {
  if (!Array.isArray(beneficiarios) || beneficiarios.length === 0) {
    throw new Error('Se requiere al menos un beneficiario');
  }
  if (beneficiarios.length > 9998) {
    throw new Error('Máximo 9998 beneficiarios por archivo');
  }

  const lineas = [];
  lineas.push(generarLineaTipo1(cabecera));

  let totalValor = 0;
  beneficiarios.forEach((b, idx) => {
    lineas.push(generarLineaTipo2(b, idx + 1));
    totalValor += b.valor;
  });

  lineas.push(generarLineaTipo3(beneficiarios.length, totalValor));

  const content = lineas.join('\r\n') + '\r\n';

  return {
    content,
    resumen: {
      totalRegistros: beneficiarios.length,
      totalValor,
      lineasTotales: lineas.length,
      identificacionArchivo: cabecera.identificacionArchivo,
      fechaPago: formatFechaYYYYMMDD(cabecera.fechaPago),
    },
  };
}

export function sugerirNombreArchivo(resumen, prefijo = 'PAG_') {
  const id = String(resumen.identificacionArchivo).padStart(6, '0');
  return `${prefijo}_${id}_${resumen.fechaPago}.txt`;
}

// ─── Encoding helper para Cloudflare Workers ─────────────────────────────
/**
 * Convierte string ASCII a Uint8Array Latin1 (para Response binario).
 * Como ya validamos solo \x20-\x7E + dígitos, charCodeAt da el byte correcto.
 */
export function contentToLatin1Bytes(content) {
  const bytes = new Uint8Array(content.length);
  for (let i = 0; i < content.length; i++) {
    bytes[i] = content.charCodeAt(i) & 0xff;
  }
  return bytes;
}
