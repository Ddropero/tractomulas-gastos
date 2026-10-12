/**
 * OCR de certificaciones bancarias colombianas
 * Portado de empleados/src/lib/ocr.ts
 *
 * Usa Gemini 2.5 Flash con responseSchema (structured output) para garantizar
 * que la respuesta SIEMPRE encaje con el shape esperado.
 *
 * Costo: ~$0.0005/imagen (gratis con free tier de Google AI Studio).
 */

import { BANCO_A_FINANDINA, BANCOS_FINANDINA } from './finandina-dispersion.js';

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const PROMPT = `Eres un asistente especializado en extraer datos de certificaciones bancarias colombianas.

Analiza el documento adjunto y devuelve EXCLUSIVAMENTE un objeto JSON con esta estructura:

{
  "banco": string | null,                  // Nombre del banco emisor (ej: "Bancolombia", "Davivienda", "BBVA Colombia")
  "tipo_cuenta": "Ahorros" | "Corriente" | null,
  "numero_cuenta": string | null,          // Solo dígitos, sin espacios ni guiones
  "titular": string | null,                // Nombre completo del titular tal como aparece
  "cedula_nit": string | null,             // Solo dígitos
  "estado": string | null,                 // "Activa", "Vigente", "Cancelada", etc.
  "confianza": number,                     // 0.0 a 1.0
  "notas": string | null                   // Cualquier observación: ilegible, sello ausente, fecha vencida, etc.
}

Reglas:
- Si un campo no se puede leer con seguridad, usar null y mencionarlo en "notas".
- "numero_cuenta" debe ser solo dígitos.
- Si el documento NO parece una certificación bancaria, devolver todos los campos en null y "notas" explicándolo, con confianza 0.
- "confianza" baja (<=0.5) si hay sellos ilegibles, fechas vencidas o el documento es ambiguo.
- Responder ÚNICAMENTE el JSON, sin markdown ni texto adicional.`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    banco:         { type: 'string', nullable: true },
    tipo_cuenta:   { type: 'string', nullable: true, enum: ['Ahorros', 'Corriente'] },
    numero_cuenta: { type: 'string', nullable: true },
    titular:       { type: 'string', nullable: true },
    cedula_nit:    { type: 'string', nullable: true },
    estado:        { type: 'string', nullable: true },
    confianza:     { type: 'number' },
    notas:         { type: 'string', nullable: true },
  },
  required: ['banco', 'tipo_cuenta', 'numero_cuenta', 'titular', 'cedula_nit', 'estado', 'confianza', 'notas'],
};

/**
 * Llama a Gemini y extrae datos de un certificado bancario.
 * @param fileBase64 string base64 (sin prefijo data:)
 * @param mimeType 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp'
 * @param apiKey GEMINI_API_KEY
 */
export async function extraerCertificadoBancario(fileBase64, mimeType, apiKey) {
  if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

  const body = {
    contents: [{
      role: 'user',
      parts: [
        { text: PROMPT },
        { inlineData: { mimeType, data: fileBase64 } },
      ],
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingBudget: 0 }, // ahorra tokens
    },
  };

  const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${errText.slice(0, 400)}`);
  }

  const data = await res.json();
  if (data.error) throw new Error(`Gemini: ${data.error.message || 'error desconocido'}`);

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini: respuesta vacía');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Gemini: respuesta no es JSON válido: ${text.slice(0, 200)}`);
  }

  // Normalizar dígitos
  if (parsed.numero_cuenta) parsed.numero_cuenta = String(parsed.numero_cuenta).replace(/\D/g, '');
  if (parsed.cedula_nit)    parsed.cedula_nit    = String(parsed.cedula_nit).replace(/\D/g, '');

  // Normalizar tipo_cuenta para nuestro sistema (lowercase)
  const tipoCuentaCocicp = parsed.tipo_cuenta === 'Ahorros' ? 'ahorros'
                         : parsed.tipo_cuenta === 'Corriente' ? 'corriente'
                         : null;

  // Mapear nombre de banco al oficial Finandina
  const bancoFinandina = mapearBanco(parsed.banco);

  return {
    ...parsed,
    tipo_cuenta_cocicp: tipoCuentaCocicp,
    banco_finandina: bancoFinandina,
    banco_match_confianza: bancoFinandina ? 'exacto' : (parsed.banco ? 'no_encontrado' : 'sin_dato'),
  };
}

/**
 * Mapea un nombre de banco extraído (con typos, variaciones) al nombre oficial
 * que espera Finandina (BANCOS_FINANDINA keys).
 *
 * Estrategia:
 * 1. Match exacto por valor de BANCO_A_FINANDINA (nombre amigable)
 * 2. Match exacto por key de BANCOS_FINANDINA (nombre oficial)
 * 3. Fuzzy: contiene/es contenido por alguno
 */
function mapearBanco(nombreExtraido) {
  if (!nombreExtraido) return null;
  const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\bsa\b|\bs\.a\.\b|\bbic\b|\bcolombia\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const target = norm(nombreExtraido);
  if (!target) return null;

  // 1. Match contra valores de BANCO_A_FINANDINA (nombres amigables → oficial)
  for (const [amigable, oficial] of Object.entries(BANCO_A_FINANDINA)) {
    if (norm(amigable) === target) return oficial;
  }

  // 2. Match contra keys de BANCOS_FINANDINA (oficial directo)
  for (const oficial of Object.keys(BANCOS_FINANDINA)) {
    if (norm(oficial) === target) return oficial;
  }

  // 3. Fuzzy: contains
  for (const [amigable, oficial] of Object.entries(BANCO_A_FINANDINA)) {
    const a = norm(amigable);
    if (a && (target.includes(a) || a.includes(target))) return oficial;
  }
  for (const oficial of Object.keys(BANCOS_FINANDINA)) {
    const a = norm(oficial);
    if (a && (target.includes(a) || a.includes(target))) return oficial;
  }

  return null;
}

/**
 * Extrae nombre y apellido de un titular tipo persona natural.
 * Ej: "JUAN CARLOS PEREZ MARTINEZ" → { nombre: "JUAN CARLOS", apellido: "PEREZ MARTINEZ" }
 *
 * Heurística simple: si tiene 2 palabras, primera=nombre, segunda=apellido.
 * Si tiene 3+, primera 1-2=nombre, resto=apellido.
 */
export function splitTitular(titular) {
  if (!titular) return { nombre: null, apellido: null };
  const partes = String(titular).trim().split(/\s+/);
  if (partes.length === 1) return { nombre: partes[0], apellido: '' };
  if (partes.length === 2) return { nombre: partes[0], apellido: partes[1] };
  if (partes.length === 3) return { nombre: partes[0], apellido: partes.slice(1).join(' ') };
  // 4+: primeras 2 son nombre, resto apellido (común en CO: 2 nombres + 2 apellidos)
  return {
    nombre: partes.slice(0, 2).join(' '),
    apellido: partes.slice(2).join(' '),
  };
}
