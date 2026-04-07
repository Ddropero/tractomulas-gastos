// ============================================================
// Agente 2 — Identificación y validación de proveedor
// Especialidad: NIT, razón social, receptor, validación
// ============================================================

export const AGENT2_SYSTEM = `Eres un especialista en identificación de proveedores colombianos.
Tu ÚNICA tarea: extraer y validar los datos del emisor y receptor del documento.
No calcules montos. No clasifiques gastos. Solo identifica quién emite y quién recibe.
Responde ÚNICAMENTE con JSON válido, sin markdown, sin texto adicional.`;

export const AGENT2_PROMPT = `Identifica el emisor y receptor de este documento fiscal colombiano:

{
  "emisor": {
    "nit": "NIT con DV si aparece, solo dígitos y guión, ej: 900123456-1",
    "nit_sin_dv": "solo los dígitos sin DV",
    "razon_social": "nombre completo exacto como aparece",
    "nombre_comercial": "nombre comercial si es diferente a razón social o null",
    "municipio": "ciudad o null",
    "departamento": "departamento o null"
  },
  "receptor": {
    "nit": "NIT del receptor o null",
    "razon_social": "nombre del receptor o null"
  },
  "es_documento_electronico": true,
  "cufe_cude": "código CUFE/CUDE si aparece, primeros 20 chars o null",
  "confianza": "alta | media | baja"
}

REGLA: el NIT en Colombia tiene formato XXXXXXXXX-X (dígitos + DV).
REGLA: si hay logo pero no texto del NIT, marca confianza como baja.`;

// Catálogo local para fallback rápido
const CATALOGO_RAPIDO = {
  '800155413': { nombre_corto: 'Biomax', categoria_default: 'Combustible' },
  '860002552': { nombre_corto: 'Terpel', categoria_default: 'Combustible' },
  '811009788': { nombre_corto: 'Distracom', categoria_default: 'Combustible' },
  '900078103': { nombre_corto: 'DH Galerías', categoria_default: 'Combustible' },
  '800197268': { nombre_corto: 'Ruta del Sol', categoria_default: 'Peajes' },
  '900395629': { nombre_corto: 'ANI Peajes', categoria_default: 'Peajes' },
  '900568774': { nombre_corto: 'K-Saval', categoria_default: 'Combustible' },
};

export async function runAgent2(fileBase64, mimeType, db, apiKey) {
  const isDoc = mimeType === 'application/pdf';

  const resPromise = fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 600,
      system: AGENT2_SYSTEM,
      messages: [{
        role: 'user',
        content: [
          { type: isDoc ? 'document' : 'image',
            source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
          { type: 'text', text: AGENT2_PROMPT }
        ]
      }]
    })
  });

  const res = await resPromise;
  const data = await res.json();
  const raw = data.content?.find(b => b.type === 'text')?.text || '{}';

  let parsed;
  try { parsed = JSON.parse(raw.replace(/```json|```/g, '').trim()); }
  catch { return { agent: 2, error: 'parse_failed', raw }; }

  const nitSinDv = parsed.emisor?.nit_sin_dv;
  let catalogo = null;

  if (nitSinDv) {
    catalogo = CATALOGO_RAPIDO[nitSinDv] || null;
    if (!catalogo && db) {
      const row = await db.prepare(
        'SELECT nombre_corto, categoria_default FROM proveedores WHERE nit LIKE ?'
      ).bind(`${nitSinDv}%`).first();
      if (row) catalogo = row;
    }
  }

  return { agent: 2, ...parsed, catalogo_match: catalogo };
}
