// ============================================================
// Agente Gemini 2.5 Flash FLOTA — OCR barato para gastos de transporte
// Mismo contrato que agent-unified.js (Sonnet 4.6)
// ============================================================

const CATALOGO_RAPIDO = {
  '800155413': { nombre_corto: 'Biomax', categoria_default: 'Combustible' },
  '860002552': { nombre_corto: 'Terpel', categoria_default: 'Combustible' },
  '811009788': { nombre_corto: 'Distracom', categoria_default: 'Combustible' },
  '900078103': { nombre_corto: 'DH Galerías', categoria_default: 'Combustible' },
  '900568774': { nombre_corto: 'K-Saval', categoria_default: 'Combustible' },
  '830053669': { nombre_corto: 'Mobil', categoria_default: 'Combustible' },
  '800197268': { nombre_corto: 'Ruta del Sol', categoria_default: 'Peajes' },
  '900395629': { nombre_corto: 'ANI Peajes', categoria_default: 'Peajes' },
  '901052639': { nombre_corto: 'Federación Municipios SIMIT', categoria_default: 'Multas' },
};

const VEHICULOS = ['STT115', 'STT121', 'UPO707'];

const CATEGORIAS = 'Combustible | Peajes | Llantas | Mantenimiento | Repuestos | Aceites y lubricantes | Lavado | Parqueadero | Seguro | Impuestos | Tecnomecánica | GPS / Tecnología | Viáticos conductor | Documentos | Multas | Báscula | Cargue / Descargue | Administración | Misceláneos';

const PROMPT = `Eres un procesador de documentos de gastos de una flota de tractomulas en Colombia (placas STT 115, STT 121, UPO 707).

Analiza el documento y devuelve EXCLUSIVAMENTE un JSON con este schema EXACTO:

{
  "fiscal": {
    "numero_documento": "prefijo + número o null",
    "tipo_documento": "factura | nota_credito | comprobante_pago | recibo | peaje | otro",
    "fecha_emision": "YYYY-MM-DD o null",
    "fecha_pago": "YYYY-MM-DD o null",
    "subtotal": 0, "iva": 0, "inc": 0, "otros_impuestos": 0, "descuentos": 0, "total": 0,
    "es_nota_credito": false,
    "medio_pago": "efectivo | tarjeta_credito | transferencia | pse | credito | null",
    "referencia_pago": "CUS o ID o null",
    "moneda": "COP"
  },
  "proveedor": {
    "nit": "con DV o null", "nit_sin_dv": "solo dígitos o null",
    "razon_social": "nombre o null", "nombre_comercial": "o null", "municipio": "o null"
  },
  "clasificacion": {
    "categoria": "una de: ${CATEGORIAS}",
    "concepto": "máx 80 chars ej: ACPM 80 gal - Terpel Villeta",
    "vehiculo": "STT115 | STT121 | UPO707 | null",
    "ruta": "origen-destino o null",
    "kilometraje": "número o null"
  },
  "confianza": "alta | media | baja",
  "es_manifiesto": false,
  "es_planilla": false
}

REGLAS:
- "es_manifiesto": true SOLO si el documento es un "MANIFIESTO ELECTRÓNICO DE CARGA" (tiene número de manifiesto + origen/destino del viaje + valor del viaje); de lo contrario false
- "es_planilla": true SOLO si es la HOJA DE CONTROL / consolidado del viaje que llena el conductor a mano (tiene filas "VIAJE N°", "VALOR FLETE", "ANTICIPO", "TOTAL GASTOS", "SALDO A COBRAR"); NO es un recibo individual ni una factura; de lo contrario false
- FECHA: el año en curso es 2026 y las fechas de recibos/facturas son recientes. Si el año leído es claramente imposible (anterior a 2024 o posterior a 2027, ej. 2016/2020/2076), es un error de OCR: corrígelo a 2026 manteniendo el mes y el día. Devuelve YYYY-MM-DD.
- TODOS los montos NUMEROS sin separadores: 1234567 no "1.234.567"
- Nota crédito: total NEGATIVO
- ACPM/diésel/gasolina → Combustible; Peajes → Peajes; Llantas/reencauche → Llantas
- Taller/frenos/sincronización → Mantenimiento; Filtros/baterías → Repuestos; Aceite → Aceites y lubricantes
- SOAT/póliza RCE → Seguro; Revisión técnico-mecánica → Tecnomecánica; SIMIT/comparendo → Multas
- Comida/hotel conductor → Viáticos conductor; Manifiesto/planilla/permisos → Documentos; Pesaje → Báscula
- VEHÍCULO: busca placa STT-115/STT-121/UPO-707 en el documento; si no aparece, null
- Imagen borrosa o ilegible: confianza = "baja"
- Responde SOLO JSON puro, sin markdown`;

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[^\d.,\-]/g, '');
  if (s.includes('.') && s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10) || 0;
  return parseFloat(s) || 0;
}

function detectarVehiculo(texto) {
  if (!texto) return null;
  const t = String(texto).toUpperCase().replace(/[\s\-]/g, '');
  for (const codigo of VEHICULOS) {
    if (t.includes(codigo)) return codigo;
  }
  return null;
}

export async function runGeminiAgent(fileBase64, mimeType, apiKey, db) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: mimeType, data: fileBase64 } },
      { text: PROMPT }
    ]}],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  // Retry ante rate limit 429 de Gemini: hasta 2 reintentos con espera incremental (1.5s, 3s)
  const backoffs = [1500, 3000];
  let res;
  for (let intento = 0; ; intento++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body)
      });
    } catch (err) {
      return { error: 'gemini_network_failed: ' + err.message };
    }
    if ((res.status === 429 || res.status === 503 || res.status === 500) && intento < backoffs.length) {
      await new Promise(r => setTimeout(r, backoffs[intento]));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `gemini_http_${res.status}`, raw: errText.slice(0, 500) };
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { error: 'gemini_parse_failed', raw: raw.slice(0, 500) };
  }

  const f = parsed.fiscal || {};
  const p = parsed.proveedor || {};
  const c = parsed.clasificacion || {};

  const nitSinDv = p.nit_sin_dv || (p.nit || '').replace(/\D/g, '');
  let catalogo = nitSinDv ? (CATALOGO_RAPIDO[nitSinDv] || null) : null;
  if (!catalogo && nitSinDv && db) {
    try {
      const row = await db.prepare(
        'SELECT nombre_corto, categoria_default FROM proveedores WHERE nit LIKE ?'
      ).bind(`${nitSinDv}%`).first();
      if (row) catalogo = row;
    } catch {}
  }

  const nombreProveedor = catalogo?.nombre_corto || p.nombre_comercial || p.razon_social || 'Proveedor desconocido';
  const categoria = c.categoria || catalogo?.categoria_default || 'Misceláneos';
  const confianza = parsed.confianza || 'media';
  const vehiculo = c.vehiculo || detectarVehiculo(`${c.concepto || ''} ${c.ruta || ''} ${f.numero_documento || ''}`);

  return {
    proveedor_nit: p.nit || null,
    proveedor_nit_sin_dv: nitSinDv || null,
    proveedor_nombre: nombreProveedor,
    proveedor_razon_social: p.razon_social || null,
    en_catalogo: !!catalogo,
    numero_documento: f.numero_documento || null,
    tipo_documento: f.tipo_documento || 'otro',
    fecha: f.fecha_pago || f.fecha_emision || null,
    fecha_emision: f.fecha_emision || null,
    categoria,
    concepto: c.concepto || 'Sin concepto',
    vehiculo: vehiculo || null,
    vehiculo_detectado: vehiculo || null,
    ruta: c.ruta || null,
    kilometraje: c.kilometraje || null,
    valor_base: toNum(f.subtotal),
    iva: toNum(f.iva),
    inc: toNum(f.inc),
    otros_impuestos: toNum(f.otros_impuestos),
    descuentos: toNum(f.descuentos),
    total: toNum(f.total),
    es_nota_credito: f.es_nota_credito || false,
    moneda: f.moneda || 'COP',
    medio_pago: f.medio_pago || null,
    referencia_pago: f.referencia_pago || null,
    confianza_global: confianza,
    es_manifiesto: parsed.es_manifiesto === true,
    es_planilla: parsed.es_planilla === true,
    estado: confianza === 'baja' ? 'revision' : 'confirmado',
    errores_parciales: null,
    notas: null,
  };
}
