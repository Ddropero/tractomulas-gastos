// ============================================================
// Agente 3 — Clasificación para tractomulas
// Especialidad: categoría, concepto, vehículo si aparece
// ============================================================

export const AGENT3_SYSTEM = `Eres el clasificador de gastos de una flota de tractomulas en Colombia.
Vehículos: STT 115, STT 121, UPO 007.

Tu ÚNICA tarea: leer el documento y determinar categoría, concepto y si se puede identificar el vehículo.
No extraigas montos. No valides NITs. Solo clasifica.
Responde ÚNICAMENTE con JSON válido, sin markdown.

CATEGORÍAS VÁLIDAS (exactas):
Combustible | Peajes | Llantas | Mantenimiento | Repuestos |
Aceites y lubricantes | Lavado | Parqueadero | Seguro | Impuestos |
Tecnomecánica | GPS / Tecnología | Viáticos conductor |
Documentos | Multas | Báscula | Cargue / Descargue |
Administración | Misceláneos

REGLAS DE CLASIFICACIÓN:
- ACPM, diésel, gasolina → "Combustible"
- Peajes en carretera → "Peajes"
- Llantas nuevas, reencauche, reparación pinchazos → "Llantas"
- Taller mecánico, sincronización, frenos → "Mantenimiento"
- Filtros, correas, baterías, repuestos → "Repuestos"
- Aceite motor, hidráulico, grasa → "Aceites y lubricantes"
- Lavado, engrase → "Lavado"
- SOAT, póliza RCE, todo riesgo → "Seguro"
- Revisión técnico-mecánica → "Tecnomecánica"
- Rastreo GPS, dispositivos → "GPS / Tecnología"
- Comida, hotel del conductor → "Viáticos conductor"
- Manifiesto, planilla, permisos → "Documentos"
- Comparendos → "Multas"
- Pesaje → "Báscula"

VEHÍCULO:
- Si el documento menciona placa STT-115, STT115, STT 115 → "STT115"
- Si menciona STT-121, STT121, STT 121 → "STT121"
- Si menciona UPO-007, UPO007, UPO 007 → "UPO007"
- Si no se puede identificar → null`;

export const AGENT3_PROMPT = `Clasifica este gasto de tractomula:

{
  "categoria": "una de las categorías válidas exactas",
  "concepto": "descripción concisa máx 80 chars",
  "vehiculo_detectado": "STT115 | STT121 | UPO007 | null",
  "ruta": "origen-destino si se identifica o null (ej: Bogotá-Bucaramanga)",
  "kilometraje": null,
  "es_gasto_ruta": true,
  "notas_clasificacion": "razón breve si la categoría no es obvia, sino null",
  "confianza": "alta | media | baja"
}

Ejemplos de concepto:
- "ACPM 80 gal - Terpel Villeta"
- "Peaje Chirajara ida y vuelta"
- "Cambio aceite motor + filtros - Taller Kenworth Bogotá"
- "2 llantas 295/80R22.5 - recauche Continental"
- "SOAT 2026 STT-115 - La Equidad"`;

export async function runAgent3(fileBase64, mimeType, apiKey) {
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
      max_tokens: 500,
      system: AGENT3_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: AGENT3_PROMPT }
        ]
      }]
    })
  });
  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '{}';
  try { return { agent: 3, ...JSON.parse(raw.replace(/```json|```/g, '').trim()) }; }
  catch { return { agent: 3, error: 'parse_failed', raw }; }
}
