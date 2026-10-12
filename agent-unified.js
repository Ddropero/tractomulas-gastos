// ============================================================
// Agente Unificado FLOTA — Extracción fiscal + proveedor + clasificación
// UNA sola llamada a Claude Sonnet 4.6 = 1 imagen
// Adaptado para tractomulas: categorías de transporte + detección de placa
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

// Vehículos de la flota — mapeo de placa → código
const VEHICULOS = {
  'STT115': ['STT115', 'STT-115', 'STT 115'],
  'STT121': ['STT121', 'STT-121', 'STT 121'],
  'UPO707': ['UPO707', 'UPO-707', 'UPO 707'],
};

const CATEGORIAS = 'Combustible | Peajes | Llantas | Mantenimiento | Repuestos | Aceites y lubricantes | Lavado | Parqueadero | Seguro | Impuestos | Tecnomecánica | GPS / Tecnología | Viáticos conductor | Documentos | Multas | Báscula | Cargue / Descargue | Administración | Misceláneos';

const SYSTEM = `Eres un procesador de documentos de gastos de una flota de tractomulas en Colombia (placas STT 115, STT 121, UPO 707).
Extrae TODO en UNA sola respuesta: valores fiscales, proveedor, clasificación y detección de vehículo.
Responde ÚNICAMENTE con JSON válido, sin markdown.`;

const PROMPT = `Analiza este documento de gasto de transporte de carga colombiano y extrae todo:

{
  "fiscal": {
    "numero_documento": "prefijo + número tal como aparece",
    "tipo_documento": "factura | nota_credito | comprobante_pago | recibo | peaje | otro",
    "fecha_emision": "YYYY-MM-DD o null",
    "fecha_pago": "YYYY-MM-DD o null",
    "subtotal": 0, "iva": 0, "inc": 0, "otros_impuestos": 0, "descuentos": 0, "total": 0,
    "es_nota_credito": false,
    "medio_pago": "efectivo | tarjeta_credito | transferencia | pse | credito | null",
    "referencia_pago": "CUS o ID transacción o null",
    "moneda": "COP"
  },
  "proveedor": {
    "nit": "con DV ej: 900123456-1",
    "nit_sin_dv": "solo dígitos",
    "razon_social": "nombre completo",
    "nombre_comercial": "o null",
    "municipio": "o null"
  },
  "clasificacion": {
    "categoria": "una de: ${CATEGORIAS}",
    "concepto": "máx 80 chars ej: ACPM 80 gal - Terpel Villeta",
    "vehiculo": "STT115 | STT121 | UPO707 | null (si aparece la placa en el documento)",
    "ruta": "origen-destino si se identifica o null",
    "kilometraje": "número de km si aparece, o null"
  },
  "confianza": "alta | media | baja",
  "es_manifiesto": false,
  "es_planilla": false
}

REGLAS:
- "es_manifiesto": true SOLO si el documento es un "MANIFIESTO ELECTRÓNICO DE CARGA" (tiene número de manifiesto + origen/destino del viaje + valor del viaje); de lo contrario false
- "es_planilla": true SOLO si es la HOJA DE CONTROL / consolidado del viaje que llena el conductor a mano (tiene filas "VIAJE N°", "VALOR FLETE", "ANTICIPO", "TOTAL GASTOS", "SALDO A COBRAR"); NO es un recibo individual ni una factura; de lo contrario false
- FECHA: el año en curso es 2026 y las fechas de recibos/facturas son recientes. Si el año leído es claramente imposible (anterior a 2024 o posterior a 2027, ej. 2016/2020/2076), es un error de OCR: corrígelo a 2026 manteniendo el mes y el día. Devuelve YYYY-MM-DD.
- Nota crédito: total NEGATIVO
- Si no puedes leer un campo: null
- ACPM/diésel/gasolina → Combustible
- Peajes en carretera → Peajes
- Llantas, reencauche → Llantas
- Taller, frenos, sincronización → Mantenimiento
- Filtros, baterías, repuestos → Repuestos
- Aceite motor/hidráulico → Aceites y lubricantes
- SOAT, póliza RCE → Seguro
- Revisión técnico-mecánica → Tecnomecánica
- Comparendos/SIMIT → Multas
- Comida/hotel del conductor → Viáticos conductor
- Manifiesto/planilla/permisos → Documentos
- Pesaje → Báscula
- VEHÍCULO: busca la placa STT-115, STT-121 o UPO-707 en el documento. Si no aparece, null.`;

function detectarVehiculo(texto) {
  if (!texto) return null;
  const t = String(texto).toUpperCase().replace(/[\s\-]/g, '');
  for (const [codigo, variantes] of Object.entries(VEHICULOS)) {
    if (t.includes(codigo)) return codigo;
  }
  return null;
}

export async function runUnifiedAgent(fileBase64, mimeType, apiKey, db) {
  const isDoc = mimeType === 'application/pdf';

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 800,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: PROMPT }
        ]
      }]
    })
  });

  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '{}';

  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { error: 'parse_failed', raw };
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

  // Vehículo: el que detecte la IA, o fallback regex sobre concepto+ruta
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
    valor_base: f.subtotal || 0,
    iva: f.iva || 0,
    inc: f.inc || 0,
    otros_impuestos: f.otros_impuestos || 0,
    descuentos: f.descuentos || 0,
    total: f.total || 0,
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
