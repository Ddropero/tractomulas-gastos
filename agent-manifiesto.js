// ============================================================
// Agente Manifiesto FLOTA — OCR de Manifiesto Electrónico de Carga (ingresos/viajes)
// Gemini 2.5 Flash primero (mismo patrón de fetch que agent-gemini.js). Si Gemini no da un resultado válido
// (429, red, JSON inválido, sin clave o en pausa) y hay clave de Anthropic, respaldo con Claude Sonnet 4.6.
// Ambos resultados pasan por UNA sola función de normalización y sanidad (normalizarManifiesto).
// ============================================================

import { geminiDisponible, gemini429, geminiBien } from './gemini-estado.js';

const VEHICULOS = ['STT115', 'STT121', 'UPO707'];

// placas: lista de la flota (por defecto la fija de siempre). Con lista vacía (instancia sin vehículos aún) se pide la placa tal cual.
// anio: año en curso para la regla de sanidad de la fecha.
export function construirPrompt(placas = VEHICULOS, anio = 2026) {
  const campoVehiculo = placas.length
    ? `placa del vehículo, mapear a ${placas.join(' | ')} o null`
    : 'placa del vehículo tal como se lee, sin espacios ni guiones (ej. ABC123), o null';
  const reglaVehiculo = placas.length
    ? `busca placa ${placas.map(p => p.slice(0, 3) + '-' + p.slice(3)).join('/')} en el documento; si no aparece, null`
    : 'devuelve la placa del vehículo tal como se lee; si no aparece, null';
  return `Eres un experto en el MANIFIESTO ELECTRÓNICO DE CARGA colombiano (documento del Ministerio de Transporte que ampara el transporte terrestre de carga por carretera).

Analiza el documento y devuelve EXCLUSIVAMENTE un JSON con este schema EXACTO:

{
  "numero_manifiesto": "número del manifiesto o null",
  "fecha_viaje": "YYYY-MM-DD (usar Fecha Expedición) o null",
  "vehiculo": "${campoVehiculo}",
  "conductor": "nombre del conductor o null",
  "origen": "Origen Viaje o null",
  "destino": "Destino Viaje o null",
  "empresa_carga": "razón social de la EMPRESA DE TRANSPORTE que expide el manifiesto (la del encabezado, junto a su NIT), ej OPL CARGA SAS, o null",
  "empresa_carga_nit": "NIT de esa empresa de transporte (el del encabezado) o null",
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
- empresa_carga NO es el "Titular Manifiesto", ni el "Poseedor o Tenedor del Vehículo", ni el conductor: esos son el dueño del camión. Es la empresa cuyo nombre y NIT encabezan el documento
- valor_flete = VALOR TOTAL VIAJE (si las cifras y el "valor en letras" no coinciden, vale el valor en letras)
- retefuente = RETENCION EN LA FUENTE
- reteica = RETENCION ICA
- otras_retenciones = suma de cualquier otra retención distinta de fuente e ICA (FOPAT, avisos y tableros, tasa bomberil). El FOPAT nunca va en reteica
- Lee cada valor en el renglón de su propia etiqueta: no corras los valores un renglón cuando hay una línea de FOPAT
- valor_neto = VALOR NETO A PAGAR
- anticipo = VALOR ANTICIPO
- saldo_a_cobrar = SALDO A PAGAR / VALOR A PAGAR
- FECHA: el año en curso es ${anio} y las fechas del manifiesto son recientes. Si el año leído es claramente imposible (anterior a ${anio - 2} o posterior a ${anio + 1}, ej. 2016/2020/2076), es un error de OCR: corrígelo a ${anio} manteniendo el mes y el día. Devuelve YYYY-MM-DD.
- VEHÍCULO: ${reglaVehiculo}
- Si la imagen NO es un manifiesto de carga, confianza = "baja"
- Imagen borrosa o ilegible: confianza = "baja"
- Responde SOLO JSON puro, sin markdown`;
}

const CAMPOS_MONTO = ['valor_flete', 'retefuente', 'reteica', 'otras_retenciones', 'valor_neto', 'anticipo', 'saldo_a_cobrar'];

// Con menos presupuesto que esto no vale la pena llamar a un modelo
const MIN_PRESUPUESTO_MS = 1500;

// Tope por llamada a Gemini; con respaldo Claude es menor para dejarle presupuesto al respaldo (si Gemini se cuelga)
const TOPE_GEMINI_MS = 12000;
const TOPE_GEMINI_CON_RESPALDO_MS = 8000;
// Con respaldo, Gemini no reintenta un 500/503 si, contando lo que tardaría el reintento, le quedaría menos que esto a Claude para extraer
const RESERVA_CLAUDE_MS = 12000;

// AbortSignal.timeout() dispara TimeoutError (o AbortError según el runtime): para nosotros es una falla de red
const esTimeout = err => !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');

function toNum(v) {
  if (typeof v === 'number') return v;
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[^\d.,\-]/g, '');
  if (s.includes('.') && s.includes(',')) return parseFloat(s.replace(/\./g, '').replace(',', '.')) || 0;
  if (/^\d{1,3}(\.\d{3})+$/.test(s)) return parseInt(s.replace(/\./g, ''), 10) || 0;
  return parseFloat(s) || 0;
}

function detectarVehiculo(texto, placas = VEHICULOS) {
  if (!texto) return null;
  const t = String(texto).toUpperCase().replace(/[\s\-]/g, '');
  for (const codigo of placas) {
    if (t.includes(codigo)) return codigo;
  }
  return null;
}

// YYYY-MM-DD y que sea una fecha real (no 2026-02-30)
function fechaValida(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

// Fecha de hoy en Colombia (UTC-5 fijo, no hay horario de verano)
function fechaHoyColombia() {
  return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Quita cercas de markdown y, si el modelo escribió texto alrededor, toma desde la primera llave hasta la última
function extraerJson(texto) {
  let s = String(texto || '').replace(/```json|```/g, '').trim();
  const ini = s.indexOf('{');
  const fin = s.lastIndexOf('}');
  if (ini !== -1 && fin > ini) s = s.slice(ini, fin + 1);
  const obj = JSON.parse(s);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('no es un objeto JSON');
  return obj;
}

// ── Gemini 2.5 Flash ──────────────────────────────────────
// Devuelve { parsed } o { error, raw } (error sin el prefijo "manifiesto_")
async function llamarGemini(fileBase64, mimeType, apiKey, { conRespaldo, deadline, prompt }) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
  const body = {
    contents: [{ parts: [
      { inline_data: { mime_type: mimeType, data: fileBase64 } },
      { text: prompt }
    ]}],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1,
      maxOutputTokens: 1024,
      thinkingConfig: { thinkingBudget: 0 }
    }
  };

  // Con respaldo Claude: un 429 (cuota) NO se reintenta (y si se repite pausa a Gemini); un 500/503 se reintenta una vez tras 1s
  // solo si, suponiendo que el reintento tarde lo mismo que el intento fallido, a Claude todavía le queda presupuesto de sobra.
  // Sin respaldo (solo Gemini) se conservan los reintentos de siempre (1.5s y 3s), también ante 429
  const backoffs = conRespaldo ? [1000] : [1500, 3000];
  let res;
  let errText = '';
  for (let intento = 0; ; intento++) {
    const restante = deadline == null ? Infinity : deadline - Date.now();
    if (restante < MIN_PRESUPUESTO_MS) return { error: 'sin_tiempo' };
    const inicioIntento = Date.now();
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Math.floor(Math.min(conRespaldo ? TOPE_GEMINI_CON_RESPALDO_MS : TOPE_GEMINI_MS, restante)))
      });
    } catch (err) {
      return { error: 'network_failed: ' + (esTimeout(err) ? 'timeout' : err.message) };
    }
    if (res.ok) { geminiBien(); break; }
    errText = await res.text().catch(() => '');
    console.warn('[gemini]', res.status, errText.slice(0, 300));
    if (res.status === 429) {
      gemini429();
      if (conRespaldo) break;
    }
    // Presupuesto que debe quedar tras la espera: con respaldo, lo que necesita Claude más lo que tardaría otro intento igual al fallido
    const reserva = conRespaldo ? RESERVA_CLAUDE_MS + (Date.now() - inicioIntento) : MIN_PRESUPUESTO_MS;
    if ((res.status === 429 || res.status === 503 || res.status === 500) && intento < backoffs.length
        && (deadline == null || deadline - Date.now() - backoffs[intento] >= reserva)) {
      await new Promise(r => setTimeout(r, backoffs[intento]));
      continue;
    }
    break;
  }
  if (!res.ok) return { error: `http_${res.status}`, raw: errText.slice(0, 500) };

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return esTimeout(err) ? { error: 'network_failed: timeout' } : { error: 'parse_failed', raw: '' };
  }
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  try {
    return { parsed: extraerJson(raw) };
  } catch {
    return { error: 'parse_failed', raw: raw.slice(0, 500) };
  }
}

// ── Claude (respaldo, o lector único si no hay clave de Gemini) ──────────────────────────
export const MODELO_CLAUDE_DEFECTO = 'claude-sonnet-4-6';
function cuerpoClaude(modelo, base) {
  // El modelo de siempre conserva la petición de siempre. Los modelos nuevos razonan antes de responder
  // (el razonamiento cuenta contra max_tokens): más margen, esfuerzo bajo y respaldo ante una negativa.
  if (modelo === MODELO_CLAUDE_DEFECTO) return { headers: {}, body: { model: modelo, ...base } };
  return {
    headers: { 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    body: { model: modelo, ...base, max_tokens: 4000, output_config: { effort: 'low' }, fallbacks: 'default' },
  };
}
// Devuelve { parsed } o { error, raw } (error sin el prefijo "manifiesto_")
async function llamarClaude(fileBase64, mimeType, anthropicKey, { deadline, prompt, modelo = MODELO_CLAUDE_DEFECTO }) {
  const isDoc = mimeType === 'application/pdf';
  const pet = cuerpoClaude(modelo, {
    max_tokens: 1200,
    messages: [{
      role: 'user',
      content: [
        { type: isDoc ? 'document' : 'image',
          source: { type: 'base64', media_type: mimeType, data: fileBase64 } },
        { type: 'text', text: prompt }
      ]
    }]
  });
  const reqBody = JSON.stringify(pet.body);

  // Un solo reintento tras 1.5s ante errores transitorios (429, 500, 502, 503, 529) si queda presupuesto
  let res;
  let errText = '';
  for (let intento = 0; ; intento++) {
    const restante = deadline == null ? Infinity : deadline - Date.now();
    if (restante < MIN_PRESUPUESTO_MS) return { error: 'sin_tiempo' };
    try {
      res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          ...pet.headers
        },
        body: reqBody,
        signal: AbortSignal.timeout(Math.floor(Math.min(25000, restante)))
      });
    } catch (err) {
      return { error: 'network_failed: ' + (esTimeout(err) ? 'timeout' : err.message) };
    }
    if (res.ok) break;
    errText = await res.text().catch(() => '');
    if (intento < 1 && [429, 500, 502, 503, 529].includes(res.status)
        && (deadline == null || deadline - Date.now() - 1500 >= MIN_PRESUPUESTO_MS)) {
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    break;
  }
  if (!res.ok) return { error: `http_${res.status}`, raw: errText.slice(0, 300) };

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return esTimeout(err) ? { error: 'network_failed: timeout' } : { error: 'parse_failed', raw: '' };
  }
  const raw = data?.content?.find(b => b.type === 'text')?.text || '';
  try {
    return { parsed: extraerJson(raw) };
  } catch {
    return { error: 'parse_failed', raw: raw.slice(0, 500) };
  }
}

// ── Normalización y sanidad (compartida por Gemini y Claude) ──
// Devuelve el objeto de siempre + _proveedor, _fallback_motivo, fecha_corregida y advertencias
function normalizarManifiesto(parsed, { proveedor, fallbackMotivo, hoy, placas = VEHICULOS }) {
  const advertencias = [];
  const anioHoy = parseInt(hoy.slice(0, 4), 10);

  const m = {};
  for (const k of CAMPOS_MONTO) m[k] = toNum(parsed[k]);

  // Número de manifiesto: solo cuenta como legible si trae al menos 3 dígitos (y alguno distinto de cero). Cualquier relleno que
  // escriba el modelo ("null", "N/A", "No legible", "ILEGIBLE", "0", "-") es no legible: guardado como número, dos manifiestos
  // borrosos distintos coincidirían en el anti-duplicado y el segundo se perdería. Se guarda el número tal como viene en el
  // manifiesto (G29841, MC017958, 006-000037498 son números reales y salen así en las facturas); el anti-duplicado compara
  // por los dígitos (ver telegram.js), así "MC-791199" y "791199" siguen siendo el mismo número entre lecturas
  const crudo = String(parsed.numero_manifiesto == null ? '' : parsed.numero_manifiesto).replace(/\s+/g, ' ').trim().slice(0, 40);
  const digitos = crudo.replace(/\D/g, '');
  const numero = digitos.length >= 3 && /[1-9]/.test(digitos) ? crudo : null;

  const vehiculo = detectarVehiculo(parsed.vehiculo, placas) ||
    detectarVehiculo(`${parsed.numero_manifiesto || ''} ${parsed.origen || ''} ${parsed.destino || ''} ${parsed.conductor || ''}`, placas);

  // Fecha: formato YYYY-MM-DD y fecha real; si el año cae fuera de [año-1, año+1] es error de OCR (2016, 2024...):
  // se reemplaza solo el año por el actual y se marca para revisión
  let fecha = null;
  let fechaCorregida = false;
  const fechaLeida = String(parsed.fecha_viaje == null ? '' : parsed.fecha_viaje).trim();
  if (fechaLeida) {
    if (!fechaValida(fechaLeida)) {
      advertencias.push(`Fecha no válida (${fechaLeida}): se dejó vacía`);
    } else {
      fecha = fechaLeida;
      const anio = parseInt(fechaLeida.slice(0, 4), 10);
      if (anio < anioHoy - 1 || anio > anioHoy + 1) {
        const corregida = String(anioHoy).padStart(4, '0') + fechaLeida.slice(4);
        if (fechaValida(corregida)) {   // 29-feb de un año bisiesto mal leído no existe en el año actual
          fecha = corregida;
          fechaCorregida = true;
          advertencias.push(`Fecha leída ${fechaLeida}; año corregido a ${anioHoy}`);
        } else {
          fecha = null;
          advertencias.push(`Fecha leída ${fechaLeida}: no existe en ${anioHoy}, se dejó vacía`);
        }
      }
    }
  }

  // Confianza declarada por el modelo (alta | media | baja); cualquier otra cosa cuenta como media
  let confianza = String(parsed.confianza || '').trim().toLowerCase();
  if (!['alta', 'media', 'baja'].includes(confianza)) confianza = 'media';

  // Aritmética (tolerancia 2 pesos), solo cuando vienen todos los montos:
  //   valor_neto = flete − retefuente − reteica − otras  ·  saldo = valor_neto − anticipo
  if (CAMPOS_MONTO.every(k => parsed[k] !== undefined && parsed[k] !== null && parsed[k] !== '')) {
    let descuadra = false;
    const netoEsperado = m.valor_flete - m.retefuente - m.reteica - m.otras_retenciones;
    if (Math.abs(m.valor_neto - netoEsperado) > 2) {
      descuadra = true;
      advertencias.push(`No cuadra: valor neto ${Math.round(m.valor_neto)} ≠ flete − retenciones ${Math.round(netoEsperado)}`);
    }
    const saldoEsperado = m.valor_neto - m.anticipo;
    if (Math.abs(m.saldo_a_cobrar - saldoEsperado) > 2) {
      descuadra = true;
      advertencias.push(`No cuadra: saldo a cobrar ${Math.round(m.saldo_a_cobrar)} ≠ neto − anticipo ${Math.round(saldoEsperado)}`);
    }
    if (descuadra && confianza === 'alta') confianza = 'media';
  }

  // Sin número de manifiesto o sin flete no hay con qué confiar en el registro
  if (!numero) advertencias.push('Sin número de manifiesto legible');
  if (!m.valor_flete) advertencias.push('Valor del flete en 0');
  if (!numero || !m.valor_flete) confianza = 'baja';

  return {
    es_manifiesto: true,
    numero_manifiesto: numero,
    fecha_viaje: fecha,
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
    valor_flete: m.valor_flete,
    retefuente: m.retefuente,
    reteica: m.reteica,
    otras_retenciones: m.otras_retenciones,
    valor_neto: m.valor_neto,
    anticipo: m.anticipo,
    saldo_a_cobrar: m.saldo_a_cobrar,
    confianza_global: confianza,
    estado: confianza === 'baja' ? 'revision' : 'confirmado',
    archivo_r2: null,
    _proveedor: proveedor,
    _fallback_motivo: fallbackMotivo || null,
    fecha_corregida: fechaCorregida,
    advertencias,
  };
}

// opts (todo opcional): { anthropicKey, deadline, hoy }
//   anthropicKey → habilita el respaldo con Claude Sonnet 4.6 (Gemini falla rápido, sin reintentos por 429)
//   deadline     → epoch ms hasta el que hay presupuesto de tiempo; cada fetch se recorta a lo que queda
//   sinGemini    → ni se intenta Gemini, directo a Claude (el llamador sabe que acaba de fallar con esta misma foto)
//   hoy          → YYYY-MM-DD para la sanidad del año (por defecto la fecha de ahora en UTC-5)
//   placas       → flota de la instancia (config-empresa.js); sin esta opción, la lista fija de siempre
export async function runManifiestoAgent(fileBase64, mimeType, apiKey, db, opts = {}) {
  const { anthropicKey, deadline, hoy, sinGemini } = opts || {};
  const modeloClaude = (opts && opts.modeloClaude) || MODELO_CLAUDE_DEFECTO;
  const limite = Number.isFinite(deadline) ? deadline : null;
  const fechaHoy = fechaValida(hoy) ? hoy : fechaHoyColombia();
  const placas = Array.isArray(opts && opts.placas) ? opts.placas : VEHICULOS;
  const prompt = construirPrompt(placas, parseInt(fechaHoy.slice(0, 4), 10));

  let parsed = null;
  let proveedor = null;
  const fallos = {};   // motivo de falla por proveedor
  const raws = {};

  // 1. Gemini. Con respaldo, si está en pausa (429 repetidos) o el llamador lo descarta ni se intenta; sin respaldo se intenta igual
  if (!apiKey) {
    fallos.gemini = 'sin_clave';
  } else if (anthropicKey && sinGemini) {
    fallos.gemini = 'omitido';
  } else if (anthropicKey && !geminiDisponible()) {
    fallos.gemini = 'pausado';
  } else {
    const g = await llamarGemini(fileBase64, mimeType, apiKey, { conRespaldo: !!anthropicKey, deadline: limite, prompt });
    if (g.parsed) { parsed = g.parsed; proveedor = 'gemini-2.5-flash'; }
    else { fallos.gemini = g.error; raws.gemini = g.raw; }
  }

  // 2. Respaldo Claude si Gemini no dio un resultado válido
  if (!parsed && anthropicKey) {
    console.log(`[MANIFIESTO] Gemini sin resultado (${fallos.gemini}), respaldo con Claude`);
    const c = await llamarClaude(fileBase64, mimeType, anthropicKey, { deadline: limite, prompt, modelo: modeloClaude });
    if (c.parsed) { parsed = c.parsed; proveedor = modeloClaude; }
    else { fallos.claude = c.error; raws.claude = c.raw; }
  }

  // 3. Fallaron todos los proveedores disponibles: el error lleva el motivo de cada uno
  if (!parsed) {
    if (!anthropicKey) {
      // Solo Gemini: formato de error de siempre (manifiesto_http_429, manifiesto_network_failed: ..., manifiesto_parse_failed)
      const out = { error: 'manifiesto_' + fallos.gemini };
      if (raws.gemini !== undefined) out.raw = raws.gemini;
      return out;
    }
    const raw = [raws.gemini && `gemini: ${raws.gemini}`, raws.claude && `claude: ${raws.claude}`].filter(Boolean).join(' | ');
    const out = { error: `manifiesto_gemini_${fallos.gemini}+claude_${fallos.claude}` };
    if (raw) out.raw = raw.slice(0, 500);
    return out;
  }

  return normalizarManifiesto(parsed, {
    proveedor,
    fallbackMotivo: proveedor === modeloClaude ? `gemini_${fallos.gemini}` : null,
    hoy: fechaHoy,
    placas
  });
}
