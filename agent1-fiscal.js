// ============================================================
// Agente 1 — Extracción fiscal pura
// Especialidad: montos, fechas, número de documento, impuestos
// ============================================================

export const AGENT1_SYSTEM = `Eres un extractor fiscal especializado en documentos colombianos.
Tu ÚNICA tarea: extraer valores numéricos, fechas y número de documento.
No clasifiques. No identifiques proveedores. Solo números y fechas.
Responde ÚNICAMENTE con JSON válido, sin markdown, sin texto adicional.`;

export const AGENT1_PROMPT = `Extrae los valores fiscales de este documento:

{
  "numero_documento": "prefijo + número completo tal como aparece",
  "tipo_documento": "factura | nota_credito | comprobante_pago | recibo | planilla | otro",
  "fecha_emision": "YYYY-MM-DD o null",
  "fecha_pago": "YYYY-MM-DD o null",
  "valores": {
    "subtotal": 0,
    "iva": 0,
    "inc": 0,
    "impo_consumo": 0,
    "otros_impuestos": 0,
    "descuentos": 0,
    "total": 0
  },
  "es_nota_credito": false,
  "medio_pago": "efectivo | tarjeta_credito | tarjeta_debito | transferencia | pse | credito | null",
  "referencia_pago": "CUS | verificación | transacción ID o null",
  "items_descripcion": "texto breve de productos/servicios visibles",
  "moneda": "COP | USD",
  "confianza": "alta | media | baja"
}

REGLA: si es nota crédito, total debe ser NEGATIVO.
REGLA: si no puedes leer un campo con certeza, usa null.`;

export async function runAgent1(fileBase64, mimeType, apiKey) {
  const isDoc = mimeType === 'application/pdf';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 800,
      system: AGENT1_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: AGENT1_PROMPT }
        ]
      }]
    })
  });
  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '{}';
  try { return { agent: 1, ...JSON.parse(raw.replace(/```json|```/g, '').trim()) }; }
  catch { return { agent: 1, error: 'parse_failed', raw }; }
}
