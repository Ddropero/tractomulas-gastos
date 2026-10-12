// ============================================================
// OCR Router — decide qué modelo usar
// Modos:
//   'sonnet'  → solo Sonnet 4.6 (default, calidad alta)
//   'gemini'  → solo Gemini 2.5 Flash (8x más barato, requiere GEMINI_API_KEY)
//   'hybrid'  → Gemini primero; si falla o confianza baja, fallback a Sonnet
// ============================================================

import { runUnifiedAgent } from './agent-unified.js';
import { runGeminiAgent }  from './agent-gemini.js';

function needsFallback(result) {
  if (!result || result.error) return { fallback: true, motivo: result?.error || 'no_result' };
  // Manifiesto de carga: no tiene 'total' de gasto (usa valor_flete). Gemini lo clasifica
  // y la extracción real la hace runManifiestoAgent → no tiene sentido el fallback a Sonnet.
  if (result.es_manifiesto) return { fallback: false };
  if (result.confianza_global === 'baja') return { fallback: true, motivo: 'confianza_baja' };
  if (!result.total || result.total === 0) return { fallback: true, motivo: 'total_cero' };
  if (!result.proveedor_nombre || result.proveedor_nombre === 'Proveedor desconocido') {
    return { fallback: true, motivo: 'proveedor_desconocido' };
  }
  return { fallback: false };
}

export async function runOcrAgent(fileBase64, mimeType, env, db) {
  const provider = env.OCR_PROVIDER || 'sonnet';
  const sonnetKey = env.ANTHROPIC_API_KEY;
  const geminiKey = env.GEMINI_API_KEY;

  // Si falta la key de Gemini, fallback automático a sonnet (zero-config safety)
  const effectiveProvider = (provider !== 'sonnet' && !geminiKey) ? 'sonnet' : provider;

  // ── Sonnet only ──
  if (effectiveProvider === 'sonnet') {
    const result = await runUnifiedAgent(fileBase64, mimeType, sonnetKey, db);
    return { ...result, _ocr_provider: 'sonnet-4.6' };
  }

  // ── Gemini only ──
  if (effectiveProvider === 'gemini') {
    const result = await runGeminiAgent(fileBase64, mimeType, geminiKey, db);
    return { ...result, _ocr_provider: 'gemini-2.5-flash' };
  }

  // ── Hybrid: Gemini → fallback Sonnet ──
  const t0 = Date.now();
  let geminiResult;
  try {
    geminiResult = await runGeminiAgent(fileBase64, mimeType, geminiKey, db);
  } catch (err) {
    geminiResult = { error: 'gemini_threw: ' + err.message };
  }
  const geminiMs = Date.now() - t0;

  const check = needsFallback(geminiResult);
  if (!check.fallback) {
    console.log(`[OCR] Gemini OK (${geminiMs}ms, conf=${geminiResult.confianza_global})`);
    return { ...geminiResult, _ocr_provider: 'gemini-2.5-flash', _ocr_ms: geminiMs };
  }

  // Fallback a Sonnet
  console.log(`[OCR] Gemini insuficiente (${check.motivo}), fallback a Sonnet`);
  const t1 = Date.now();
  const sonnetResult = await runUnifiedAgent(fileBase64, mimeType, sonnetKey, db);
  const sonnetMs = Date.now() - t1;

  return {
    ...sonnetResult,
    _ocr_provider: 'sonnet-4.6-fallback',
    _ocr_fallback_reason: check.motivo,
    _ocr_ms_gemini: geminiMs,
    _ocr_ms_sonnet: sonnetMs,
  };
}
