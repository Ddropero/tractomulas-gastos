// ============================================================
// Agente Manifiesto Gemini 2.5 Flash FLOTA — OCR de Manifiesto Electrónico de Carga (ingresos/viajes)
// Mismo patrón de fetch/retry que agent-gemini.js
// ============================================================

const VEHICULOS = ['STT115', 'STT121', 'UPO707'];

const PROMPT = `Eres un experto en el MANIFIESTO ELECTRÓNICO DE CARGA colombiano (documento del Ministerio de Transporte que ampara el transporte terrestre de carga por carretera).

Analiza el documento y devuelve EXCLUSIVAMENTE un JSON con este schema EXACTO:

{
  "numero_manifiesto": "número del manifiesto o null",
  "fecha_viaje": "YYYY-MM-DD (usar Fecha Expedición) o null",
  "vehiculo": "placa del vehículo, mapear a STT115 | STT121 | UPO707 o null",
  "conductor": "nombre del conductor o null",
  "origen": "Origen Viaje o null",
  "destino": "Destino Viaje o null",
  "empresa_carga": "titular del manifiesto / empresa que contrata el transporte, ej OPL CARGA SAS, o null",
  "empresa_carga_nit": "NIT de la empresa de carga o null",
  "remitente": "remitente de la mercancía o null",
  "destinatario": "destinatario de la mercancía o null",
  "mercancia": "descripción de la mercancía o null",
  "peso_kg": 0,
  "valor_flete": 0,
  "retefuente": 0,
  "reteica": 0,
  "otras_retenciones": 0,
  "valor_neto": 0,
  "anticipo": 0,
  "saldo_a_cobrar": 0,
  "confianza": "alta | media | baja"
}

REGLAS:
- TODOS los montos NUMEROS sin separadores: 5800000 no "5.800.000"
- valor_flete = VALOR TOTAL VIAJE
- retefuente = RETENCION EN LA FUENTE
- reteica = RETENCION ICA
- otras_retenciones = suma de cualquier otra retención distinta de fuente e ICA
- valor_neto = VALOR NETO A PAGAR
- anticipo = VALOR ANTICIPO
- saldo_a_cobrar = SALDO A PAGAR / VALOR A PAGAR
- VEHÍCULO: busca placa STT-115/STT-121/UPO-707 en el documento; si no aparece, null
- Si la imagen NO es un manifiesto de carga, confianza = "baja"
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

export async function runManifiestoAgent(fileBase64, mimeType, apiKey, db) {
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
      return { error: 'manifiesto_network_failed: ' + err.message };
    }
    if ((res.status === 429 || res.status === 503 || res.status === 500) && intento < backoffs.length) {
      await new Promise(r => setTimeout(r, backoffs[intento]));
      continue;
    }
    break;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    return { error: `manifiesto_http_${res.status}`, raw: errText.slice(0, 500) };
  }

  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/```json|```/g, '').trim());
  } catch {
    return { error: 'manifiesto_parse_failed', raw: raw.slice(0, 500) };
  }

  const confianza = parsed.confianza || 'media';
  const vehiculo = detectarVehiculo(parsed.vehiculo) ||
    detectarVehiculo(`${parsed.numero_manifiesto || ''} ${parsed.origen || ''} ${parsed.destino || ''} ${parsed.conductor || ''}`);

  return {
    es_manifiesto: true,
    numero_manifiesto: parsed.numero_manifiesto || null,
    fecha_viaje: parsed.fecha_viaje || null,
    vehiculo: vehiculo || null,
    conductor: parsed.conductor || null,
    origen: parsed.origen || null,
    destino: parsed.destino || null,
    empresa_carga: parsed.empresa_carga || null,
    empresa_carga_nit: parsed.empresa_carga_nit || null,
    remitente: parsed.remitente || null,
    destinatario: parsed.destinatario || null,
    mercancia: parsed.mercancia || null,
    peso_kg: toNum(parsed.peso_kg),
    valor_flete: toNum(parsed.valor_flete),
    retefuente: toNum(parsed.retefuente),
    reteica: toNum(parsed.reteica),
    otras_retenciones: toNum(parsed.otras_retenciones),
    valor_neto: toNum(parsed.valor_neto),
    anticipo: toNum(parsed.anticipo),
    saldo_a_cobrar: toNum(parsed.saldo_a_cobrar),
    confianza_global: confianza,
    estado: confianza === 'baja' ? 'revision' : 'confirmado',
    archivo_r2: null,
  };
}
