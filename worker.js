// ============================================================
// Tractomulas Gastos — Worker Cloudflare
// OCR Router (Gemini→Sonnet) + dimensión vehículo
// Bindings: DB (D1) | BUCKET (R2) | ANTHROPIC_API_KEY (secret)
// ============================================================

import { runOcrAgent } from './agent-router.js';
import { runManifiestoAgent } from './agent-manifiesto.js';
import { generarReporteContadora } from './export-contadora.js';
import { facturarViajeAliaddo, facturaManualAliaddo, enviarFacturaEmailAliaddo, probarEnvioEmailAliaddo, aliaddoDiagnostico, diagnosticoFacturacionAliaddo, listarClientesAliaddo, generarSoporteGasto, listarCuentasAliaddo, listarComprobantesAliaddo } from './aliaddo.js';
import { checkRecurrentes } from './recurrentes.js';
import { generateReport } from './report-pdf.js';
import {
  hashPassword, verifyPassword,
  generateTotpSecret, verifyTotp, totpUri, qrCodeUrl,
  createSession, deleteSession, verifyRequest, sha256Hex
} from './auth.js';
import { handleTelegramUpdate, setupWebhook, checkWebhookHealth, healWebhook } from './telegram.js';
import {
  generarArchivoDispersion,
  sugerirNombreArchivo,
  contentToLatin1Bytes,
  BANCO_A_FINANDINA,
  BANCOS_FINANDINA,
} from './finandina-dispersion.js';
import { extraerCertificadoBancario, splitTitular } from './ocr-certificado-bancario.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

async function checkDuplicate(db, numeroDocumento, total, fecha, proveedorNit, vehiculo) {
  if (!db) return null;
  const veh = vehiculo || null;
  // 1. Exacto por numero_documento (+ proveedor si lo hay) — bloqueo duro
  if (numeroDocumento && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ? AND proveedor_nit = ?'
    ).bind(numeroDocumento, proveedorNit).first();
    if (row) return { tipo: 'numero_documento', registro: row };
  } else if (numeroDocumento) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ?'
    ).bind(numeroDocumento).first();
    if (row) return { tipo: 'numero_documento', registro: row };
  }
  // 2. Mismo total + fecha + proveedor + vehículo (difuso)
  if (total && fecha && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND proveedor_nit = ? AND (vehiculo = ? OR vehiculo IS NULL OR ? IS NULL)'
    ).bind(total, fecha, proveedorNit, veh, veh).first();
    if (row) return { tipo: 'total_fecha_proveedor', registro: row };
  }
  // 3. Mismo total + fecha + vehículo, solo cuando NO hay número de documento (difuso, más laxo)
  if (total && fecha && !numeroDocumento) {
    const row = await db.prepare(
      "SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND (vehiculo = ? OR vehiculo IS NULL OR ? IS NULL) AND (numero_documento IS NULL OR numero_documento = '')"
    ).bind(total, fecha, veh, veh).first();
    if (row) return { tipo: 'total_fecha', registro: row };
  }
  return null;
}

// ── Formato COP sin decimales ───────────────────────────────
function formatCOP(value) {
  if (!value && value !== 0) return '0';
  return Math.round(Math.abs(value)).toLocaleString('es-CO');
}

// ── Envío automático de la factura emitida al correo del cliente (Aliaddo no lo hace por API) ──
// Se apaga con ALIADDO_AUTO_EMAIL=false. Nunca lanza: devuelve {ok, error?} o null si está apagado.
async function enviarEmailFactura(env, token, invoiceId) {
  if (String(env.ALIADDO_AUTO_EMAIL || '').toLowerCase() === 'false' || !invoiceId) return null;
  try {
    const r = await enviarFacturaEmailAliaddo(token, invoiceId, env.ALIADDO_REPLY_TO || 'ddropero@gmail.com');
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

    // ── Auth middleware ─────────────────────────────────────
    // Rutas públicas (no requieren auth). Las apps de captura usan
    // /api/upload y /api/confirm sin login para ingreso rápido por los conductores.
    // Sensible al MÉTODO: '/api/viajes' es público solo en POST (captura de conductores);
    // el GET (listado de ingresos/utilidades) exige login.
    const PUBLIC_ROUTES = new Set([
      'POST /api/auth/login',
      'POST /api/auth/register',
      'POST /api/auth/setup-2fa',
      'POST /api/auth/verify-2fa',
      'POST /api/upload',
      'POST /api/confirm',
      'POST /api/manifiesto/upload',
      'POST /api/viajes',
      'POST /api/telegram/webhook',
      'GET /api/telegram/health',
    ]);
    const isPublic = PUBLIC_ROUTES.has(`${request.method} ${url.pathname}`)
      || url.pathname.startsWith('/api/soporte/');

    let authUser = null;
    if (!isPublic && url.pathname.startsWith('/api/')) {
      authUser = await verifyRequest(request, env);
      if (!authUser) return json({ error: 'Unauthorized' }, 401);
    }

    // ── POST /api/upload ────────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/upload') {
      try {
        const form     = await request.formData();
        const file     = form.get('file');
        const usuario  = form.get('usuario') || 'david';
        const vehiculo = form.get('vehiculo') || null;
        if (!file) return json({ error: 'No file' }, 400);

        const mimeType = file.type;
        const buf      = await file.arrayBuffer();
        const bytes    = new Uint8Array(buf);
        let binary     = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64      = btoa(binary);

        const r2Key     = `soportes/${Date.now()}-${file.name}`;
        const r2Promise = env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType: mimeType } });

        // ★ OCR Router: hybrid (Gemini→Sonnet fallback) | sonnet | gemini
        const preview = await runOcrAgent(b64, mimeType, env, env.DB);

        await r2Promise;

        if (preview.error) {
          return json({ ok: false, error: 'Error procesando documento: ' + preview.error }, 500);
        }

        // Hoja de control del conductor → NO es gasto (mismo criterio que telegram.js)
        if (preview.es_planilla === true) {
          await env.BUCKET.delete(r2Key).catch(() => {});
          return json({ ok: false, es_planilla: true,
            error: 'Hoja de control de viaje detectada — no es un gasto. Los gastos se toman de los recibos individuales y el ingreso del manifiesto.' }, 422);
        }
        // Manifiesto de carga → es un INGRESO (tabla viajes), no un gasto
        if (preview.es_manifiesto === true) {
          await env.BUCKET.delete(r2Key).catch(() => {});
          return json({ ok: false, es_manifiesto: true, redirigir: 'manifiesto',
            error: 'Manifiesto de carga detectado — es un ingreso, no un gasto. Usa "Subir manifiesto".' }, 422);
        }

        preview.usuario = usuario;
        preview.archivo_r2 = r2Key;
        // Mantener dimensión vehículo: el form manda prioridad sobre el detectado por OCR
        if (vehiculo) preview.vehiculo = vehiculo;
        if (!preview.vehiculo) preview.vehiculo = preview.vehiculo_detectado || null;

        const dup = await checkDuplicate(env.DB, preview.numero_documento, preview.total, preview.fecha, preview.proveedor_nit, preview.vehiculo);
        preview.es_posible_duplicado = !!dup;
        preview.duplicado_info = dup;

        // ── Auto-confirm: proveedor conocido + confianza alta + sin duplicado + total positivo + vehículo definido ──
        const wantsAuto = form.get('auto_confirm') === '1';
        if (wantsAuto
            && preview.en_catalogo === true
            && preview.confianza_global === 'alta'
            && !preview.es_posible_duplicado
            && preview.total > 0
            && preview.vehiculo) {

          const ins = await env.DB.prepare(`
            INSERT INTO gastos
              (numero, fecha, vehiculo, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, inc, otros_impuestos,
               total, es_nota_credito, medio_pago, referencia_pago,
               kilometraje, ruta, archivo_r2, usuario, estado, notas)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
            RETURNING numero
          `).bind(
            preview.fecha, preview.vehiculo, preview.proveedor_nit, preview.proveedor_nombre,
            preview.numero_documento, preview.concepto, preview.categoria,
            preview.valor_base || 0, preview.iva || 0, preview.inc || 0,
            preview.otros_impuestos || 0, preview.total,
            preview.es_nota_credito ? 1 : 0,
            preview.medio_pago, preview.referencia_pago,
            preview.kilometraje || null, preview.ruta || null,
            preview.archivo_r2, preview.usuario || 'david',
            'confirmado', preview.notas || null
          ).first();
          const numero = ins.numero;

          preview.auto_confirmado = true;
          return json({ ok: true, preview, auto_confirmado: true, numero });
        }

        return json({ ok: true, preview });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/confirm ───────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/confirm') {
      try {
        const body = await request.json();

        if (!body.vehiculo) {
          return json({ ok: false, error: 'Selecciona un vehículo' }, 400);
        }
        if (!body.fecha || typeof body.total !== 'number' || !isFinite(body.total)) {
          return json({ ok: false, error: 'Faltan campos obligatorios: fecha y total numérico' }, 400);
        }

        // Anti-duplicado robusto (saltable con forzar:true tras aviso al usuario; nunca salta el nº de documento exacto)
        const dup = body.forzar === true
          ? await (async () => {
              const d = await checkDuplicate(env.DB, body.numero_documento, body.total, body.fecha, body.proveedor_nit, body.vehiculo);
              return d && d.tipo === 'numero_documento' ? d : null;
            })()
          : await checkDuplicate(env.DB, body.numero_documento, body.total, body.fecha, body.proveedor_nit, body.vehiculo);
        if (dup) {
          const r = dup.registro;
          const motivo = dup.tipo === 'numero_documento' ? 'mismo número de documento'
            : dup.tipo === 'total_fecha_proveedor' ? 'mismo total, fecha y proveedor'
            : 'mismo total y fecha';
          return json({ ok: false, error: `Duplicado (#${r.numero} — ${r.proveedor_nombre}): ${motivo}`, duplicado: true, forzable: dup.tipo !== 'numero_documento' }, 409);
        }

        // Auto-detección de recurrente: si el NIT coincide con una obligación activa, marca 1
        let esRecurrenteAuto = body.es_recurrente ? 1 : 0;
        if (!body.es_recurrente && body.proveedor_nit) {
          const nitLimpio = (body.proveedor_nit || '').replace(/\D/g, '');
          if (nitLimpio) {
            const match = await env.DB.prepare(
              `SELECT id FROM obligaciones WHERE activo = 1 AND REPLACE(REPLACE(proveedor_nit, '-', ''), ' ', '') LIKE ?`
            ).bind(`${nitLimpio.slice(0, 9)}%`).first().catch(() => null);
            if (match) esRecurrenteAuto = 1;
          }
        }

        const ins = await env.DB.prepare(`
          INSERT INTO gastos
            (numero, fecha, vehiculo, proveedor_nit, proveedor_nombre, numero_documento,
             concepto, categoria, valor_base, iva, inc, otros_impuestos,
             total, es_nota_credito, medio_pago, referencia_pago,
             kilometraje, ruta, archivo_r2, usuario, estado, notas, es_recurrente)
          SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                 ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
          RETURNING numero
        `).bind(
          body.fecha, body.vehiculo, body.proveedor_nit || null, body.proveedor_nombre || null,
          body.numero_documento || null, body.concepto || null, body.categoria || null,
          body.valor_base || 0, body.iva || 0, body.inc || 0,
          body.otros_impuestos || 0, body.total,
          body.es_nota_credito ? 1 : 0,
          body.medio_pago || null, body.referencia_pago || null,
          body.kilometraje || null, body.ruta || null,
          body.archivo_r2 || null, body.usuario || 'david',
          body.estado || 'confirmado', body.notas || null,
          esRecurrenteAuto
        ).first();
        const numero = ins.numero;

        // Notificar por email (un correo por gasto)
        if (env.RESEND_API_KEY) {
          const fmtCOP = v => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', maximumFractionDigits:0 }).format(v);
          const vehiculo = body.vehiculo || '—';
          const emailHtml = `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:500px;margin:0 auto;background:#0d0e0f;color:#e8ebee;padding:20px;border-radius:10px;">
            <h2 style="font-size:16px;font-weight:300;color:#a0d0f0;margin:0 0 12px;">🚛 Nuevo gasto registrado</h2>
            <div style="background:#141517;border:1px solid #222427;border-radius:8px;padding:14px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="background:#1a2a3a;color:#a0d0f0;padding:2px 8px;border-radius:4px;font-size:11px;">${vehiculo}</span>
                <strong style="color:#b8f0a0;font-size:16px;">${fmtCOP(body.total)}</strong>
              </div>
              <div style="color:#e8ebee;font-size:13px;font-weight:500;">${body.proveedor_nombre || '—'}</div>
              <div style="color:#6b7580;font-size:12px;margin-top:4px;">${body.concepto || '—'}</div>
              <div style="color:#6b7580;font-size:11px;margin-top:6px;">
                ${body.fecha || '—'} · ${body.categoria || '—'} · #${numero}
              </div>
            </div>
            <div style="text-align:center;margin-top:14px;">
              <a href="${env.FRONTEND_URL || 'https://flota.davidduque.com'}" style="display:inline-block;background:#a0d0f0;color:#0d1a0d;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;">Ver dashboard</a>
            </div>
          </div>`;

          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
            body: JSON.stringify({
              from: env.ALERT_EMAIL_FROM || 'Flota Alertas <alertas@davidduque.com>',
              to: [env.ALERT_EMAIL_TO || 'david@davidduque.com'],
              subject: `🚛 ${vehiculo} — ${fmtCOP(body.total)} — ${body.proveedor_nombre || body.concepto || 'Gasto'}`,
              html: emailHtml
            })
          }).catch(() => {});
        }

        return json({ ok: true, numero }, 201);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/cruce-dian ──────────────────────────────────
    // Cruza el reporte DIAN (facturación electrónica recibida) contra los gastos del
    // período. Los gastos que NO aparecen en el reporte no son electrónicos → requieren
    // documento equivalente (documento soporte). Marca gastos.es_electronica (1/0).
    if (request.method === 'POST' && url.pathname === '/api/cruce-dian') {
      try {
        const { filas } = await request.json();
        if (!filas || !Array.isArray(filas)) return json({ error: 'Se espera { filas: [...] }' }, 400);

        // Rango de fechas del reporte — si no hay fechas válidas, abortar (evita marcar TODO el histórico)
        const fechasOrden = filas.map(f => f.fecha).filter(f => /^\d{4}-\d{2}-\d{2}/.test(String(f || ''))).sort();
        if (!fechasOrden.length) {
          return json({ error: 'El reporte no trae fechas válidas — verifica la columna Fecha del Excel de la DIAN.' }, 400);
        }
        const desde = fechasOrden[0];
        const hasta = fechasOrden[fechasOrden.length - 1];

        // Índices del reporte DIAN para matchear
        const dianPorDoc = {};            // clave 'nit|doc' o 'doc'
        const dianPorNitFechaTotal = {};
        const dianPorNitTotal = {};       // clave 'nit|total' → array de filas (consumibles)
        filas.forEach(f => {
          const doc = (f.numero_documento || '').toString().trim().toUpperCase();
          const nit = (f.nit_emisor || '').replace(/\D/g, '');
          const total = Math.round(Math.abs(parseFloat(f.total) || 0));
          if (doc) { dianPorDoc[nit ? `${nit}|${doc}` : doc] = f; if (!dianPorDoc[doc]) dianPorDoc[doc] = f; }
          if (nit && f.fecha) dianPorNitFechaTotal[`${nit}|${f.fecha}|${total}`] = f;
          if (nit && total) (dianPorNitTotal[`${nit}|${total}`] = dianPorNitTotal[`${nit}|${total}`] || []).push(f);
        });

        // Gastos del período cubierto por el reporte
        const gastosRes = await env.DB.prepare(
          'SELECT id, numero, numero_documento, proveedor_nit, proveedor_nombre, fecha, total, concepto, categoria, vehiculo, es_electronica, doc_equivalente FROM gastos WHERE fecha BETWEEN ? AND ?'
        ).bind(desde, hasta).all();
        const gastos = gastosRes.results || [];

        const con_electronica = [];
        const requieren_doc_equivalente = [];
        const dianMatched = new Set();

        for (const g of gastos) {
          const doc = (g.numero_documento || '').toString().trim().toUpperCase();
          const nit = (g.proveedor_nit || '').replace(/\D/g, '');
          const total = Math.round(Math.abs(g.total || 0));
          let match = null;
          if (doc) match = (nit && dianPorDoc[`${nit}|${doc}`]) || (!nit && dianPorDoc[doc]) || null;
          if (!match && nit && g.fecha) match = dianPorNitFechaTotal[`${nit}|${g.fecha}|${total}`] || null;
          if (match && dianMatched.has(match)) match = null; // ya consumida por otro gasto
          // Fallback NIT+total acotado a ±3 días y consumiendo la fila (una factura DIAN = un gasto)
          if (!match && nit && total && g.fecha) {
            const gd = Date.parse(g.fecha);
            const cands = dianPorNitTotal[`${nit}|${total}`] || [];
            match = cands.find(f => !dianMatched.has(f) && f.fecha && Math.abs(Date.parse(f.fecha) - gd) <= 3 * 86400000) || null;
          }
          if (match) {
            dianMatched.add(match);
            con_electronica.push({ gasto: g, dian: match });
          } else {
            requieren_doc_equivalente.push(g);
          }
        }

        // Facturas del reporte DIAN que no matchearon ningún gasto (¿falta registrarlas?)
        const dian_sin_gasto = filas.filter(f => !dianMatched.has(f) && (f.total || f.nit_emisor));

        // Persistir es_electronica (sin pisar los que ya tienen documento equivalente generado)
        const updates = [];
        for (const c of con_electronica) {
          if (c.gasto.es_electronica !== 1) updates.push(env.DB.prepare('UPDATE gastos SET es_electronica = 1 WHERE id = ?').bind(c.gasto.id));
        }
        for (const g of requieren_doc_equivalente) {
          if (g.es_electronica !== 0 && !g.doc_equivalente) updates.push(env.DB.prepare('UPDATE gastos SET es_electronica = 0 WHERE id = ?').bind(g.id));
        }
        if (updates.length) await env.DB.batch(updates);

        return json({
          ok: true,
          periodo: { desde, hasta },
          total_dian: filas.length,
          total_con_electronica: con_electronica.length,
          total_doc_equivalente: requieren_doc_equivalente.length,
          total_dian_sin_gasto: dian_sin_gasto.length,
          con_electronica,
          requieren_doc_equivalente,
          dian_sin_gasto
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/import-peajes ───────────────────────────────
    // Importa el reporte de Vía Rápida (tag de telepeaje) como gastos categoría
    // 'Peajes'. Cada paso de peaje -> un gasto, asignado al vehículo por placa y
    // auto-enlazado al viaje más cercano (±3 días). Dedupe por numero_documento
    // sintético para no re-importar al subir el reporte de nuevo. Mismo patrón de
    // inserción atómica que /api/confirm y de matcheo que /api/cruce-dian.
    if (request.method === 'POST' && url.pathname === '/api/import-peajes') {
      try {
        const { filas } = await request.json();
        if (!filas || !Array.isArray(filas)) return json({ error: 'Se espera { filas: [...] }' }, 400);

        const normPlaca = p => (p || '').toString().toUpperCase().replace(/[^A-Z0-9]/g, '');
        const toDays = (s) => { const t = Date.parse(String(s).slice(0, 10) + 'T00:00:00Z'); return isNaN(t) ? null : t / 86400000; };

        // Precarga TODO una sola vez (evita queries por fila → soporta miles de filas)
        const [vehRes, dupRes, viajesRes] = await Promise.all([
          env.DB.prepare('SELECT placa FROM vehiculos').all(),
          env.DB.prepare("SELECT numero_documento FROM gastos WHERE numero_documento LIKE 'VR-%'").all(),
          env.DB.prepare('SELECT id, vehiculo, fecha_viaje FROM viajes').all(),
        ]);
        const placasValidas = new Set();
        for (const r of (vehRes.results || [])) { const n = normPlaca(r.placa); if (n) placasValidas.add(n); }
        const existentes = new Set((dupRes.results || []).map(r => r.numero_documento));
        const viajesPorVeh = {};
        for (const v of (viajesRes.results || [])) {
          (viajesPorVeh[v.vehiculo] = viajesPorVeh[v.vehiculo] || []).push({ id: v.id, dias: toDays(v.fecha_viaje) });
        }

        const usuario = (authUser && authUser.email) || 'viarapida';
        let importados = 0, omitidos = 0;
        const sinVehiculoSet = new Set();
        const vistos = new Set(); // dedupe dentro del mismo archivo
        const stmts = [];
        // Numeración atómica (MAX+1 dentro del mismo statement) — evita colisión UNIQUE
        // con inserciones concurrentes de Telegram/confirm durante el import.
        const insertSql = `INSERT INTO gastos
              (numero, fecha, vehiculo, proveedor_nit, proveedor_nombre, numero_documento,
               concepto, categoria, valor_base, iva, total, medio_pago,
               usuario, estado, notas, viaje_id)
            SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
                   ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?`;

        for (const f of filas) {
          const placaNorm = normPlaca(f.placa);
          if (!placaNorm || !placasValidas.has(placaNorm)) {
            sinVehiculoSet.add(placaNorm || (f.placa || '').toString().trim() || '(vacío)');
            continue;
          }
          const vehiculo = placaNorm;
          const valor = Number(f.valor);
          if (!Number.isFinite(valor) || valor <= 0) continue;

          const fechaPeaje = (f.fecha || '').toString().slice(0, 10).trim();
          const hora = (f.hora || '').toString().trim();
          const estacion = (f.estacion || '').toString().trim();
          const estacionSlug = estacion.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
          const numeroDocumento = 'VR-' + vehiculo + '-' + fechaPeaje + '-' + hora + '-' + estacionSlug + '-' + Math.round(valor);

          if (existentes.has(numeroDocumento) || vistos.has(numeroDocumento)) { omitidos++; continue; }
          vistos.add(numeroDocumento);

          // Auto-enlace: viaje del mismo vehículo con la fecha más cercana (±3 días), en JS
          let viajeId = null;
          const gd = toDays(fechaPeaje);
          if (gd != null) {
            let bestDiff = Infinity;
            for (const c of (viajesPorVeh[vehiculo] || [])) {
              if (c.dias == null) continue;
              const diff = Math.abs(c.dias - gd);
              if (diff <= 3 && diff < bestDiff) { bestDiff = diff; viajeId = c.id; }
            }
          }

          const proveedorNombre = ('Peaje ' + estacion).slice(0, 100);
          const concepto = ('Peaje ' + estacion + (hora ? ' ' + hora : '')).slice(0, 80);
          stmts.push(env.DB.prepare(insertSql).bind(
            fechaPeaje, vehiculo, null, proveedorNombre, numeroDocumento,
            concepto, 'Peajes', valor, 0, valor, 'Vía Rápida (tag)',
            usuario, 'confirmado', 'Importado de Vía Rápida', viajeId
          ));
          importados++;
        }

        // Inserta en lotes de 50 (dentro del límite de subrequests del Worker)
        for (let i = 0; i < stmts.length; i += 50) {
          await env.DB.batch(stmts.slice(i, i + 50));
        }

        return json({
          ok: true,
          importados,
          omitidos,
          sin_vehiculo: [...sinVehiculoSet],
          total_filas: filas.length
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PATCH /api/gastos/:id ─────────────────────────────────
    // Actualiza campos selectivos de un gasto (toggle es_recurrente, categoría, etc.)
    if (request.method === 'PATCH' && url.pathname.startsWith('/api/gastos/')) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const body = await request.json();
        const allowed = ['es_recurrente', 'categoria', 'concepto', 'estado',
                         'vehiculo', 'kilometraje', 'ruta',
                         'pagado_via', 'fecha_pago_masivo', 'viaje_id',
                         'es_electronica', 'doc_equivalente'];
        const sets = [];
        const vals = [];
        for (const k of allowed) {
          if (k in body) {
            sets.push(`${k} = ?`);
            vals.push(body[k]);
          }
        }
        if (sets.length === 0) return json({ error: 'Sin campos para actualizar' }, 400);

        sets.push("actualizado_en = datetime('now')");
        vals.push(id);

        await env.DB.prepare(`UPDATE gastos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/gastos/:id ──────────────────────────────
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/gastos/')) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const row = await env.DB.prepare('SELECT id, numero, archivo_r2, doc_equivalente FROM gastos WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Registro no encontrado' }, 404);

        const forzar = url.searchParams.get('forzar') === '1';
        if (row.doc_equivalente && !forzar) {
          return json({ error: `Tiene documento soporte emitido (${row.doc_equivalente}). Anúlalo en Aliaddo primero, o borra con ?forzar=1 (conserva el soporte).`, requiere_forzar: true }, 409);
        }

        // Con documento fiscal emitido conservamos el soporte en R2 aunque se fuerce el borrado
        if (row.archivo_r2 && !row.doc_equivalente) {
          try { await env.BUCKET.delete(row.archivo_r2); } catch {}
        }

        await env.DB.prepare('DELETE FROM gastos WHERE id = ?').bind(id).run();
        return json({ ok: true, deleted: row.numero });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/gastos ─────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/gastos') {
      const p     = url.searchParams;
      const desde = p.get('desde') || '2026-01-01';
      const hasta = p.get('hasta') || '2026-12-31';
      const cat   = p.get('categoria');
      const veh   = p.get('vehiculo');

      let q = 'SELECT * FROM gastos WHERE fecha BETWEEN ? AND ?';
      let v = [desde, hasta];
      if (cat) { q += ' AND categoria = ?'; v.push(cat); }
      if (veh) { q += ' AND vehiculo = ?'; v.push(veh); }
      q += ' ORDER BY fecha DESC, id DESC';

      const result = await env.DB.prepare(q).bind(...v).all();
      const rows = result.results || [];
      const total  = rows.reduce((s, r) => s + r.total, 0);
      const porCategoria = rows.reduce((acc, r) => {
        acc[r.categoria] = (acc[r.categoria] || 0) + r.total;
        return acc;
      }, {});
      const porVehiculo = rows.reduce((acc, r) => {
        acc[r.vehiculo] = (acc[r.vehiculo] || 0) + r.total;
        return acc;
      }, {});

      return json({
        registros: rows,
        total_registros: rows.length,
        gran_total: total,
        por_categoria: porCategoria,
        por_vehiculo: porVehiculo
      });
    }

    // ── GET /api/soporte/* ────────────────────────────────────
    if (request.method === 'GET' && url.pathname.startsWith('/api/soporte/')) {
      try {
        const rawKey = url.pathname.replace('/api/soporte/', '');
        const key = decodeURIComponent(rawKey);
        if (!key) return json({ error: 'Key requerida' }, 400);
        // Solo servir soportes del prefijo esperado (evita leer keys arbitrarias del bucket)
        if (!key.startsWith('soportes/')) return json({ error: 'Forbidden' }, 403);

        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'Archivo no encontrado', key_tried: key }, 404);

        return new Response(obj.body, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${key.split('/').pop()}"`,
            'Cache-Control': 'private, max-age=3600'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // VIAJES / INGRESOS (manifiestos electrónicos de carga)
    // ════════════════════════════════════════════════════════════════════

    // ── POST /api/manifiesto/upload (PÚBLICO, mirror de /api/upload) ──────
    if (request.method === 'POST' && url.pathname === '/api/manifiesto/upload') {
      try {
        const form     = await request.formData();
        const file     = form.get('file');
        const usuario  = form.get('usuario') || 'andrea';
        const vehiculo = form.get('vehiculo') || null;
        if (!file) return json({ error: 'No file' }, 400);

        const mimeType = file.type;
        const buf      = await file.arrayBuffer();
        const bytes    = new Uint8Array(buf);
        let binary     = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64      = btoa(binary);

        const r2Key     = `soportes/${Date.now()}-${file.name}`;
        const r2Promise = env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType: mimeType } });

        const preview = await runManifiestoAgent(b64, mimeType, env.GEMINI_API_KEY, env.DB);

        await r2Promise;

        if (preview.error) {
          return json({ ok: false, error: 'Error procesando manifiesto: ' + preview.error }, 500);
        }

        preview.archivo_r2 = r2Key;
        preview.usuario = usuario;
        // El form manda prioridad sobre el detectado por OCR
        if (vehiculo) preview.vehiculo = vehiculo;

        // Detección de duplicado por numero_manifiesto
        let dup = null;
        if (preview.numero_manifiesto) {
          dup = await env.DB.prepare(
            'SELECT id, numero, numero_manifiesto, valor_flete FROM viajes WHERE numero_manifiesto = ?'
          ).bind(preview.numero_manifiesto).first().catch(() => null);
        }
        preview.es_posible_duplicado = !!dup;
        preview.duplicado_info = dup;

        return json({ ok: true, preview });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/viajes (PÚBLICO, mirror de /api/confirm) ───────────────
    if (request.method === 'POST' && url.pathname === '/api/viajes') {
      try {
        const body = await request.json();

        if (!body.fecha_viaje) return json({ ok: false, error: 'Falta fecha_viaje' }, 400);
        if (!body.vehiculo)    return json({ ok: false, error: 'Selecciona un vehículo' }, 400);

        const ins = await env.DB.prepare(`
          INSERT INTO viajes
            (numero, numero_manifiesto, fecha_viaje, vehiculo, conductor, origen, destino,
             empresa_carga, empresa_carga_nit, remitente, destinatario, mercancia, peso_kg,
             valor_flete, retefuente, reteica, otras_retenciones, valor_neto, anticipo,
             saldo_a_cobrar, estado_cobro, valor_cobrado, fecha_cobro,
             estado_factura, numero_factura, fecha_factura,
             archivo_r2, usuario, estado, notas, creado_en, actualizado_en)
          SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM viajes),
                 ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,
                 datetime('now'), datetime('now')
          RETURNING numero
        `).bind(
          body.numero_manifiesto || null, body.fecha_viaje, body.vehiculo,
          body.conductor || null, body.origen || null, body.destino || null,
          body.empresa_carga || null, body.empresa_carga_nit || null,
          body.remitente || null, body.destinatario || null, body.mercancia || null,
          body.peso_kg || 0,
          body.valor_flete || 0, body.retefuente || 0, body.reteica || 0,
          body.otras_retenciones || 0, body.valor_neto || 0, body.anticipo || 0,
          body.saldo_a_cobrar || 0, body.estado_cobro || 'pendiente',
          body.valor_cobrado || 0, body.fecha_cobro || null,
          body.estado_factura || 'pendiente', body.numero_factura || null,
          body.fecha_factura || null,
          body.archivo_r2 || null, body.usuario || 'andrea',
          body.estado || 'confirmado', body.notas || null
        ).first();
        const numero = ins.numero;

        // Notificar por email (un correo por viaje) — mirror del de gastos, no bloqueante
        if (env.RESEND_API_KEY) {
          const fmtCOP = v => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', maximumFractionDigits:0 }).format(v || 0);
          const vehiculo = body.vehiculo || '—';
          const emailHtml = `
          <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:500px;margin:0 auto;background:#0d0e0f;color:#e8ebee;padding:20px;border-radius:10px;">
            <h2 style="font-size:16px;font-weight:300;color:#b8f0a0;margin:0 0 12px;">🚛 Nuevo viaje registrado</h2>
            <div style="background:#141517;border:1px solid #222427;border-radius:8px;padding:14px;">
              <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
                <span style="background:#1a2a3a;color:#a0d0f0;padding:2px 8px;border-radius:4px;font-size:11px;">${vehiculo}</span>
                <strong style="color:#b8f0a0;font-size:16px;">${fmtCOP(body.valor_flete)}</strong>
              </div>
              <div style="color:#e8ebee;font-size:13px;font-weight:500;">${body.empresa_carga || '—'}</div>
              <div style="color:#6b7580;font-size:12px;margin-top:4px;">${body.origen || '—'} → ${body.destino || '—'}</div>
              <div style="color:#6b7580;font-size:11px;margin-top:6px;">
                ${body.fecha_viaje || '—'} · Manifiesto ${body.numero_manifiesto || '—'} · #${numero}
              </div>
            </div>
            <div style="text-align:center;margin-top:14px;">
              <a href="${env.FRONTEND_URL || 'https://flota.davidduque.com'}" style="display:inline-block;background:#b8f0a0;color:#0d1a0d;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;">Ver dashboard</a>
            </div>
          </div>`;

          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
            body: JSON.stringify({
              from: env.ALERT_EMAIL_FROM || 'Flota Alertas <alertas@davidduque.com>',
              to: [env.ALERT_EMAIL_TO || 'david@davidduque.com'],
              subject: `🚛 Viaje ${vehiculo} — ${fmtCOP(body.valor_flete)} — ${body.empresa_carga || 'Manifiesto'}`,
              html: emailHtml
            })
          }).catch(() => {});
        }

        return json({ ok: true, numero }, 201);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/viajes ──────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/viajes') {
      try {
        const p     = url.searchParams;
        const desde = p.get('desde') || '2026-01-01';
        const hasta = p.get('hasta') || '2026-12-31';
        const veh   = p.get('vehiculo');
        const ec    = p.get('estado_cobro');
        const ef    = p.get('estado_factura');

        let q = 'SELECT * FROM viajes WHERE fecha_viaje BETWEEN ? AND ?';
        const v = [desde, hasta];
        if (veh) { q += ' AND vehiculo = ?'; v.push(veh); }
        if (ec)  { q += ' AND estado_cobro = ?'; v.push(ec); }
        if (ef)  { q += ' AND estado_factura = ?'; v.push(ef); }
        q += ' ORDER BY fecha_viaje DESC, id DESC';

        const result = await env.DB.prepare(q).bind(...v).all();
        const viajes = result.results || [];

        // Total de gastos por viaje (una sola query agregada)
        const gRes = await env.DB.prepare(
          'SELECT viaje_id, COALESCE(SUM(total),0) as tg FROM gastos WHERE viaje_id IS NOT NULL GROUP BY viaje_id'
        ).all();
        const gastosPorViaje = {};
        for (const row of (gRes.results || [])) gastosPorViaje[row.viaje_id] = row.tg;

        let totalFlete = 0, totalAnticipo = 0, totalSaldo = 0, totalGastos = 0, totalUtilidad = 0, totalComision = 0;
        const porVehiculo = {};

        const registros = viajes.map(vj => {
          const tg = gastosPorViaje[vj.id] || 0;
          const comision = vj.comision_conductor || 0;
          // Utilidad = flete − gastos − comisión (misma fórmula que auditoría y export-resumen de la contadora)
          const utilidad = (vj.valor_flete || 0) - tg - comision;
          totalFlete    += vj.valor_flete || 0;
          totalAnticipo += vj.anticipo || 0;
          totalSaldo    += vj.saldo_a_cobrar || 0;
          totalGastos   += tg;
          totalComision += comision;
          totalUtilidad += utilidad;
          const veh2 = vj.vehiculo || '—';
          if (!porVehiculo[veh2]) porVehiculo[veh2] = { flete: 0, gastos: 0, comision: 0, utilidad: 0 };
          porVehiculo[veh2].flete    += vj.valor_flete || 0;
          porVehiculo[veh2].gastos   += tg;
          porVehiculo[veh2].comision += comision;
          porVehiculo[veh2].utilidad += utilidad;
          return { ...vj, total_gastos: tg, utilidad };
        });

        return json({
          registros,
          total_registros: registros.length,
          total_flete: totalFlete,
          total_anticipo: totalAnticipo,
          total_saldo: totalSaldo,
          total_gastos: totalGastos,
          total_comision: totalComision,
          total_utilidad: totalUtilidad,
          por_vehiculo: porVehiculo
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/auto-asignar-gastos ─────────────────────────
    // Para datos históricos/desordenados: enlaza cada gasto SIN viaje al viaje del
    // mismo vehículo con la fecha_viaje más cercana (dentro de ±ventana_dias). Un solo UPDATE.
    if (request.method === 'POST' && url.pathname === '/api/auto-asignar-gastos') {
      try {
        const body = await request.json().catch(() => ({}));
        const ventana = Number(body.ventana_dias) > 0 ? Math.min(Number(body.ventana_dias), 60) : 5;
        const vehiculo = body.vehiculo || null;
        const mes = (body.mes && /^\d{4}-\d{2}$/.test(body.mes)) ? body.mes : null;

        // Gastos sin viaje (en el alcance)
        const cond = ['viaje_id IS NULL', 'vehiculo IS NOT NULL', 'fecha IS NOT NULL'];
        const params = [];
        if (vehiculo) { cond.push('vehiculo = ?'); params.push(vehiculo); }
        if (mes) { cond.push('fecha LIKE ?'); params.push(`${mes}%`); }
        const gRes = await env.DB.prepare(`SELECT id, vehiculo, fecha FROM gastos WHERE ${cond.join(' AND ')}`).bind(...params).all();
        const gastos = gRes.results || [];

        // Viajes por vehículo (para matchear por fecha)
        const vRes = await env.DB.prepare('SELECT id, vehiculo, fecha_viaje FROM viajes').all();
        const toDays = (s) => { const t = Date.parse(String(s) + 'T00:00:00Z'); return isNaN(t) ? null : t / 86400000; };
        const viajesPorVeh = {};
        for (const v of (vRes.results || [])) {
          (viajesPorVeh[v.vehiculo] = viajesPorVeh[v.vehiculo] || []).push({ id: v.id, dias: toDays(v.fecha_viaje) });
        }

        const updates = [];
        let asignados = 0, sinMatch = 0;
        for (const g of gastos) {
          const gd = toDays(g.fecha);
          const cands = viajesPorVeh[g.vehiculo] || [];
          let bestId = null, bestDiff = Infinity;
          if (gd != null) {
            for (const c of cands) {
              if (c.dias == null) continue;
              const diff = Math.abs(c.dias - gd);
              if (diff <= ventana && diff < bestDiff) { bestDiff = diff; bestId = c.id; }
            }
          }
          if (bestId != null) { updates.push(env.DB.prepare('UPDATE gastos SET viaje_id = ? WHERE id = ?').bind(bestId, g.id)); asignados++; }
          else sinMatch++;
        }
        if (updates.length) await env.DB.batch(updates);

        return json({ ok: true, asignados, sin_match: sinMatch, total_sin_viaje: gastos.length, ventana_dias: ventana });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/aliaddo/diagnostico ─────────────────────────
    // Verifica el token y descubre sucursal + ítem "fletes" de la cuenta.
    if (request.method === 'GET' && url.pathname === '/api/aliaddo/diagnostico') {
      try {
        const r = await aliaddoDiagnostico(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO);
        return json(r, r && r.error ? 400 : 200);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/gastos/:id/soporte (genera documento soporte en Aliaddo) ──
    if (request.method === 'POST' && url.pathname.match(/^\/api\/gastos\/\d+\/soporte$/)) {
      try {
        const id = parseInt(url.pathname.split('/')[3]);
        const g = await env.DB.prepare('SELECT * FROM gastos WHERE id = ?').bind(id).first();
        if (!g) return json({ error: 'Gasto no encontrado' }, 404);
        if (g.doc_equivalente) return json({ error: `Ya tiene documento soporte (${g.doc_equivalente})` }, 400);
        if (g.es_electronica === 1) return json({ error: 'El gasto ya tiene factura electrónica (cruce DIAN); no requiere documento soporte' }, 400);
        // Claim atómico: bloquea doble emisión concurrente
        const claim = await env.DB.prepare("UPDATE gastos SET doc_equivalente='EN_PROCESO' WHERE id=? AND (doc_equivalente IS NULL OR doc_equivalente='')").bind(id).run();
        if (!claim.meta.changes) return json({ error: 'Documento soporte ya emitido o en proceso' }, 409);
        const r = await generarSoporteGasto(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO, g, { branchId: env.ALIADDO_BRANCH_ID, itemGastoId: env.ITEM_GASTO_ID });
        if (r.error) {
          // Rechazo confirmado → liberar (reintentables); red/timeout → 'VERIFICAR' (bloquea re-emisión)
          await env.DB.prepare("UPDATE gastos SET doc_equivalente=? WHERE id=? AND doc_equivalente='EN_PROCESO'").bind(r.indeterminado ? 'VERIFICAR' : null, id).run();
          return json({ error: r.error, indeterminado: !!r.indeterminado, payload: r.payload || null }, 502);
        }
        await env.DB.prepare("UPDATE gastos SET doc_equivalente = ?, es_electronica = 0, actualizado_en = datetime('now') WHERE id = ?")
          .bind(String(r.numero || r.bill_id || ''), id).run();
        return json({ ok: true, numero: r.numero, cuds: r.cuds || r.cufe, bill_id: r.bill_id });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/gastos/soporte-candidatos?mes=YYYY-MM (TODOS los candidatos a documento equivalente del mes) ──
    if (request.method === 'GET' && url.pathname === '/api/gastos/soporte-candidatos') {
      try {
        const mes = url.searchParams.get('mes');
        const cond = ["(doc_equivalente IS NULL OR doc_equivalente = '')", '(es_electronica IS NULL OR es_electronica = 0)', "proveedor_nit IS NOT NULL", "proveedor_nit != ''", 'total > 0'];
        const params = [];
        if (mes && /^\d{4}-\d{2}$/.test(mes)) { cond.push('fecha LIKE ?'); params.push(`${mes}%`); }
        const gRes = await env.DB.prepare(`SELECT id, numero, fecha, proveedor_nit, proveedor_nombre, numero_documento, concepto, categoria, vehiculo, total, es_electronica FROM gastos WHERE ${cond.join(' AND ')} ORDER BY fecha, numero`).bind(...params).all();
        const candidatos = gRes.results || [];
        const suma = candidatos.reduce((a, g) => a + (g.total || 0), 0);
        return json({ ok: true, mes: mes || null, candidatos, total: candidatos.length, suma });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/gastos/soportes-masivo — body {ids:[...]} genera esos; sin body = mes/limit sobre es_electronica=0 ──
    if (request.method === 'POST' && url.pathname === '/api/gastos/soportes-masivo') {
      try {
        let ids = null;
        try { const b = await request.json(); if (b && Array.isArray(b.ids)) ids = b.ids.map(Number).filter(n => n > 0); } catch (e) {}
        const token = env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO;
        let pend = [];
        if (ids && ids.length) {
          const sel = ids.slice(0, 40);
          const ph = sel.map(() => '?').join(',');
          const gRes = await env.DB.prepare(`SELECT * FROM gastos WHERE id IN (${ph}) AND (doc_equivalente IS NULL OR doc_equivalente = '') AND (es_electronica IS NULL OR es_electronica = 0) AND total > 0 ORDER BY fecha`).bind(...sel).all();
          pend = gRes.results || [];
        } else {
          const mes = url.searchParams.get('mes');
          const limit = Math.min(parseInt(url.searchParams.get('limit')) || 40, 40);
          const cond = ['es_electronica = 0', "(doc_equivalente IS NULL OR doc_equivalente = '')", 'proveedor_nit IS NOT NULL', 'total > 0'];
          const params = [];
          if (mes && /^\d{4}-\d{2}$/.test(mes)) { cond.push('fecha LIKE ?'); params.push(`${mes}%`); }
          const gRes = await env.DB.prepare(`SELECT * FROM gastos WHERE ${cond.join(' AND ')} ORDER BY fecha LIMIT ${limit}`).bind(...params).all();
          pend = gRes.results || [];
        }
        const opts = { branchId: env.ALIADDO_BRANCH_ID, itemGastoId: env.ITEM_GASTO_ID };
        let generados = 0; const errores = [];
        for (const g of pend) {
          // Claim atómico por gasto: evita doble emisión si dos lotes corren a la vez
          const claim = await env.DB.prepare("UPDATE gastos SET doc_equivalente='EN_PROCESO' WHERE id=? AND (doc_equivalente IS NULL OR doc_equivalente='')").bind(g.id).run();
          if (!claim.meta.changes) { errores.push({ gasto: g.numero || g.id, error: 'Ya emitido o en proceso' }); continue; }
          let r;
          try { r = await generarSoporteGasto(token, g, opts); }
          catch (e) { r = { error: e.message, indeterminado: true }; }
          if (r.error) {
            await env.DB.prepare("UPDATE gastos SET doc_equivalente=? WHERE id=? AND doc_equivalente='EN_PROCESO'").bind(r.indeterminado ? 'VERIFICAR' : null, g.id).run();
            errores.push({ gasto: g.numero || g.id, error: r.error });
            if (r.indeterminado) break; // resultado desconocido → detener el lote para no arriesgar duplicados
            continue;
          }
          await env.DB.prepare("UPDATE gastos SET doc_equivalente = ?, es_electronica = 0, actualizado_en = datetime('now') WHERE id = ?")
            .bind(String(r.numero || r.bill_id || ''), g.id).run();
          generados++;
        }
        return json({ ok: true, candidatos: pend.length, generados, errores: errores.slice(0, 20), total_errores: errores.length });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/terceros?q= (autocomplete: busca en los terceros importados de Aliaddo por nombre o NIT) ──
    if (request.method === 'GET' && url.pathname === '/api/terceros') {
      try {
        const q = (url.searchParams.get('q') || '').trim();
        if (q.length < 2) return json({ ok: true, terceros: [] });
        const like = `%${q}%`;
        const r = await env.DB.prepare("SELECT aliaddo_id, identificacion, nombre, email, ciudad, tipo FROM terceros WHERE nombre LIKE ? OR identificacion LIKE ? ORDER BY (nombre LIKE ? ) DESC, nombre LIMIT 15")
          .bind(like, like, `${q}%`).all();
        return json({ ok: true, terceros: r.results || [] });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/conciliar-combustible — cruza recibos (D1) vs documentos DIAN subidos (detección de falsificación) ──
    if (request.method === 'POST' && url.pathname === '/api/conciliar-combustible') {
      try {
        const body = await request.json();
        const filas = Array.isArray(body.filas) ? body.filas : [];
        const mes = /^\d{4}-\d{2}$/.test(body.mes || '') ? body.mes : null;
        const vehiculo = body.vehiculo || null;
        const soloComb = body.soloCombustible !== false;
        const dig = s => String(s || '').replace(/\D/g, '');
        const aln = s => String(s || '').replace(/[^0-9a-zA-Z]/g, '').toUpperCase();
        const diasDiff = (a, b) => { if (!a || !b) return 999; return Math.abs((Date.parse(a) - Date.parse(b)) / 86400000); };

        // Índice de documentos DIAN (excluye peajes)
        const dianDocs = filas.map((f, i) => ({
          i, nit9: dig(f.nit).slice(0, 9), doc: aln(f.documento), docRaw: f.documento || '',
          nombre: f.nombre || '', fecha: f.fecha || null, total: Math.round(Number(f.total) || 0),
          tipo: f.tipo || '', usado: false,
        })).filter(d => d.total > 0 && !/peaje/i.test(d.tipo));
        // NITs que SÍ emiten factura electrónica (aparecen como emisor en el reporte DIAN)
        const dianNits = new Set(dianDocs.map(d => d.nit9).filter(Boolean));

        // Recibos cargados a conciliar
        const cond = ['1=1']; const params = [];
        if (mes) { cond.push('fecha LIKE ?'); params.push(mes + '%'); }
        if (vehiculo) { cond.push('vehiculo = ?'); params.push(vehiculo); }
        if (soloComb) cond.push("(LOWER(categoria) LIKE '%combust%' OR LOWER(concepto) LIKE '%combust%' OR LOWER(concepto) LIKE '%acpm%' OR LOWER(concepto) LIKE '%diesel%' OR LOWER(concepto) LIKE '%gasolina%')");
        const rRes = await env.DB.prepare(`SELECT id, numero, fecha, vehiculo, proveedor_nit, proveedor_nombre, numero_documento, categoria, total, medio_pago, archivo_r2 FROM gastos WHERE ${cond.join(' AND ')} ORDER BY vehiculo, fecha`).bind(...params).all();
        const recibos = rRes.results || [];

        const filasOut = recibos.map(g => {
          const gNit9 = dig(g.proveedor_nit).slice(0, 9);
          const gDoc = aln(g.numero_documento);
          const gTot = Math.round(Number(g.total) || 0);
          let match = null, criterio = null;
          if (gDoc) { const d = dianDocs.find(x => !x.usado && x.doc && x.doc === gDoc); if (d) { match = d; criterio = 'folio'; } }
          if (!match && gNit9) { const d = dianDocs.find(x => !x.usado && x.nit9 === gNit9 && Math.abs(x.total - gTot) < 1); if (d) { match = d; criterio = 'nit_valor'; } }
          if (!match) { const d = dianDocs.find(x => !x.usado && Math.abs(x.total - gTot) < 1 && diasDiff(x.fecha, g.fecha) <= 2); if (d) { match = d; criterio = 'valor_fecha'; } }
          if (match) match.usado = true;
          let estado, nota;
          if (match) {
            if (criterio === 'valor_fecha') { estado = 'revisar'; nota = 'Valor y fecha coinciden con una factura DIAN, pero el nº de documento o el NIT del recibo no coinciden — verifica la foto original'; }
            else { estado = 'ok'; nota = 'Tiene factura electrónica en la DIAN'; }
          } else if (gNit9 && dianNits.has(gNit9)) {
            estado = 'sospechoso';
            nota = 'El proveedor SÍ emite factura electrónica (aparece en la DIAN con otras facturas) pero ESTA factura no existe — posible recibo alterado/falsificado';
          } else {
            estado = 'doc_soporte';
            nota = 'El proveedor no emite factura electrónica (no aparece en la DIAN) — corresponde hacerle documento soporte en Aliaddo';
          }
          return {
            id: g.id, numero: g.numero, fecha: g.fecha, vehiculo: g.vehiculo,
            proveedor: g.proveedor_nombre, nit: g.proveedor_nit, doc: g.numero_documento,
            total: gTot, medio_pago: g.medio_pago, archivo_r2: g.archivo_r2 || null,
            estado, nota, criterio,
            dian: match ? { doc: match.docRaw, nombre: match.nombre, fecha: match.fecha, total: match.total } : null,
          };
        });

        const sum = (pred) => filasOut.filter(pred).reduce((a, f) => a + f.total, 0);
        const resumen = {
          total_recibos: filasOut.length,
          ok: filasOut.filter(f => f.estado === 'ok').length,
          revisar: filasOut.filter(f => f.estado === 'revisar').length,
          sospechoso: filasOut.filter(f => f.estado === 'sospechoso').length,
          doc_soporte: filasOut.filter(f => f.estado === 'doc_soporte').length,
          monto_sospechoso: sum(f => f.estado === 'sospechoso'),
          monto_doc_soporte: sum(f => f.estado === 'doc_soporte'),
          dian_docs: dianDocs.length,
        };
        const dianHuerfanos = dianDocs.filter(d => !d.usado && d.total >= 40000)
          .map(d => ({ doc: d.docRaw, nombre: d.nombre, fecha: d.fecha, total: d.total, tipo: d.tipo }))
          .sort((a, b) => b.total - a.total);
        return json({ ok: true, mes, vehiculo, recibos: filasOut, resumen, dian_huerfanos: dianHuerfanos });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/aliaddo/importar-clientes (trae todos los terceros de Aliaddo a la base local) ──
    if (request.method === 'POST' && url.pathname === '/api/aliaddo/importar-clientes') {
      try {
        const token = env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO;
        let page = 1, total = 0;
        const upserts = [];
        while (page <= 40) {
          const r = await listarClientesAliaddo(token, { page });
          if (r.error) return json({ error: r.error, importados_hasta_ahora: total }, 502);
          const cs = r.clientes || [];
          if (!cs.length) break;
          for (const c of cs) {
            if (!c.id) continue;
            upserts.push(env.DB.prepare("INSERT OR REPLACE INTO terceros (aliaddo_id, identificacion, nombre, tipo, email, ciudad, actualizado_en) VALUES (?,?,?,?,?,?,datetime('now'))")
              .bind(c.id, c.identificacion || '', c.nombre || '', c.tipo || '', c.email || '', c.ciudad || ''));
            total++;
          }
          if (cs.length < 50) break;
          page++;
        }
        for (let i = 0; i < upserts.length; i += 50) await env.DB.batch(upserts.slice(i, i + 50));
        const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM terceros').first();
        return json({ ok: true, importados: total, paginas: page, total_en_base: cnt?.n || 0 });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/aliaddo/cuentas?page=1 (plan de cuentas PUC) ──
    if (request.method === 'GET' && url.pathname === '/api/aliaddo/cuentas') {
      try {
        const page = parseInt(url.searchParams.get('page')) || 1;
        const r = await listarCuentasAliaddo(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO, { page });
        return json(r, r && r.error ? 400 : 200);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/aliaddo/comprobantes (tipos de comprobante contable) ──
    if (request.method === 'GET' && url.pathname === '/api/aliaddo/comprobantes') {
      try {
        const r = await listarComprobantesAliaddo(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO);
        return json(r, r && r.error ? 400 : 200);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/aliaddo/clientes?q=NIT&page=1 (clientes registrados en Aliaddo) ──
    if (request.method === 'GET' && url.pathname === '/api/aliaddo/clientes') {
      try {
        const q = (url.searchParams.get('q') || '').trim();
        const page = parseInt(url.searchParams.get('page')) || 1;
        const soloDigitos = q.replace(/\D/g, '');
        const opts = { page, itemsPerPage: 50 };
        if (soloDigitos) opts.identification = soloDigitos;
        const r = await listarClientesAliaddo(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO, opts);
        return json(r, r && r.error ? 400 : 200);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/viajes/:id/facturar (emite factura electrónica en Aliaddo) ──
    if (request.method === 'POST' && url.pathname.match(/^\/api\/viajes\/\d+\/facturar$/)) {
      try {
        const id = parseInt(url.pathname.split('/')[3]);
        const vj = await env.DB.prepare('SELECT * FROM viajes WHERE id = ?').bind(id).first();
        if (!vj) return json({ error: 'Viaje no encontrado' }, 404);
        if (vj.estado_factura === 'facturado') {
          return json({ error: vj.numero_factura ? `El viaje ya está facturado (No. ${vj.numero_factura})` : 'El viaje figura facturado pero sin número — verifícalo en Aliaddo antes de reintentar (edita el viaje a estado pendiente para re-emitir).' }, 400);
        }

        // La factura electrónica se emite con la fecha de HOY (Bogotá UTC-5), no la del viaje (la DIAN valida oportunidad)
        const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
        const dueDate = new Date(Date.parse(hoy + 'T00:00:00Z') + 30 * 86400000).toISOString().slice(0, 10);
        const token = env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO;
        const aliOpts = { dueDate, hoy, branchId: env.ALIADDO_BRANCH_ID, itemFletesCode: env.ITEM_FLETES_CODE, emisorNit: env.EMISOR_NIT };

        // ?dryRun=1 → simulación: arma la factura completa y la devuelve SIN enviarla ni tocar la base
        if (url.searchParams.get('dryRun') === '1') {
          const sim = await facturarViajeAliaddo(token, vj, { ...aliOpts, dryRun: true });
          if (sim.error) return json({ ok: false, dryRun: true, error: sim.error, motivo: sim.motivo || null }, 400);
          return json({ ...sim, viaje: { id: vj.id, numero: vj.numero, manifiesto: vj.numero_manifiesto, cliente: vj.empresa_carga, estado_factura: vj.estado_factura || 'pendiente' } });
        }

        // Claim atómico: solo un request concurrente gana y llama a Aliaddo (evita doble factura)
        const claim = await env.DB.prepare("UPDATE viajes SET estado_factura='en_proceso', actualizado_en=datetime('now') WHERE id=? AND (estado_factura IS NULL OR estado_factura='pendiente')").bind(id).run();
        if (!claim.meta.changes) return json({ error: 'El viaje ya está facturado o con factura en proceso' }, 409);

        const r = await facturarViajeAliaddo(token, vj, aliOpts);
        if (r.error) {
          // Rechazo confirmado → volver a 'pendiente' (reintentable). Red/timeout → dejar 'en_proceso' y verificar manual.
          if (!r.indeterminado) await env.DB.prepare("UPDATE viajes SET estado_factura='pendiente' WHERE id=? AND estado_factura='en_proceso'").bind(id).run();
          return json({ error: r.error, indeterminado: !!r.indeterminado, payload: r.payload || null }, 502);
        }

        const numeroGuardar = String(r.numero || r.invoice_id || '').trim() || 'SIN-NUMERO';
        const partes = [`Factura Aliaddo ${numeroGuardar}`];
        if (r.state_dian) partes.push(`DIAN: ${r.state_dian}${r.motivo_dian ? ' (' + r.motivo_dian + ')' : ''}`);
        if (r.cufe) partes.push(`CUFE ${r.cufe}`);
        if (r.url_pdf) partes.push(`PDF ${r.url_pdf}`);
        await env.DB.prepare(
          "UPDATE viajes SET estado_factura='facturado', numero_factura=?, fecha_factura=datetime('now','-5 hours'), notas=COALESCE(notas,'')||?, actualizado_en=datetime('now') WHERE id=?"
        ).bind(numeroGuardar, '\n' + partes.join(' · '), id).run();

        // Envío al cliente por correo (después de guardar la factura: si falla, la factura sigue emitida)
        const email = await enviarEmailFactura(env, token, r.invoice_id);
        if (email) {
          await env.DB.prepare("UPDATE viajes SET notas=COALESCE(notas,'')||? WHERE id=?")
            .bind(email.ok ? ' · Correo enviado al cliente' : ` · Correo NO enviado: ${email.error}`, id).run();
        }

        return json({ ok: true, numero: r.numero, cufe: r.cufe, invoice_id: r.invoice_id, state_dian: r.state_dian, motivo_dian: r.motivo_dian, url_pdf: r.url_pdf, email });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/aliaddo/diagnostico-facturacion — sucursales (isDefault/status) + últimas facturas (solo lectura) ──
    if (request.method === 'GET' && url.pathname === '/api/aliaddo/diagnostico-facturacion') {
      try {
        const d = await diagnosticoFacturacionAliaddo(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO);
        return json(d, d.error ? 400 : 200);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── GET /api/aliaddo/probar-envio-email — prueba SIN efectos (lista vacía) de qué ruta de envío acepta el token ──
    if (request.method === 'GET' && url.pathname === '/api/aliaddo/probar-envio-email') {
      try {
        return json(await probarEnvioEmailAliaddo(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO));
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/aliaddo/facturas/:invoiceId/enviar-email — reenvío manual al cliente ──
    if (request.method === 'POST' && url.pathname.match(/^\/api\/aliaddo\/facturas\/[0-9a-f-]{36}\/enviar-email$/i)) {
      try {
        const invoiceId = url.pathname.split('/')[4];
        const r = await enviarFacturaEmailAliaddo(env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO, invoiceId, env.ALIADDO_REPLY_TO || 'ddropero@gmail.com');
        return json(r, r.ok ? 200 : 502);
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/aliaddo/facturas/copia-email — copia de facturas (ZIP oficial DIAN + PDF) al correo del dueño ──
    // body: { facturas: [{ numero, url_zip, url_pdf, cliente? }] }. Destinatario FIJO (ALERT_EMAIL_TO) y solo
    // archivos del almacenamiento de facturas de Aliaddo: no sirve como relay a terceros.
    if (request.method === 'POST' && url.pathname === '/api/aliaddo/facturas/copia-email') {
      try {
        if (!env.RESEND_API_KEY) return json({ error: 'Falta RESEND_API_KEY' }, 500);
        const body = await request.json().catch(() => ({}));
        const facturas = Array.isArray(body.facturas) ? body.facturas.slice(0, 20) : [];
        if (!facturas.length) return json({ error: 'Sin facturas' }, 400);
        const urlOk = (u) => /^https:\/\/storage\.googleapis\.com\/aliaddo-tenant-sales\/invoices\/\d+\/[\w.-]+\.(zip|pdf)$/.test(String(u || ''));
        const b64 = (buf) => {
          const bytes = new Uint8Array(buf); let s = '';
          for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          return btoa(s);
        };
        // El bucket no es público: Aliaddo entrega una URL firmada temporal (la misma que usa "Exportar ZIP" en la web)
        const firmada = async (u) => {
          const r = await fetch('https://app.aliaddo.net/attachments/signUrl?url=' + encodeURIComponent(u) + '&redirect=false');
          if (!r.ok) return null;
          const t = await r.text();
          let s; try { s = JSON.parse(t); } catch { s = t.trim(); }
          return typeof s === 'string' && s.startsWith('https://storage.googleapis.com/aliaddo-tenant-sales/') ? s : null;
        };
        const attachments = [], faltan = [];
        let total = 0;
        for (const f of facturas) {
          const num = String(f.numero || '').replace(/[^\w-]/g, '').slice(0, 20) || 'sin-numero';
          for (const [u, ext] of [[f.url_zip, 'zip'], [f.url_pdf, 'pdf']]) {
            if (!u) continue;
            if (!urlOk(u)) { faltan.push(`${num}.${ext}: URL no permitida`); continue; }
            const s = await firmada(u);
            if (!s) { faltan.push(`${num}.${ext}: Aliaddo no dio URL firmada`); continue; }
            const res = await fetch(s);
            if (!res.ok) { faltan.push(`${num}.${ext}: HTTP ${res.status}`); continue; }
            const buf = await res.arrayBuffer();
            total += buf.byteLength;
            if (total > 20 * 1024 * 1024) return json({ error: 'Los adjuntos superan 20 MB' }, 400);
            attachments.push({ filename: `Factura_${num}.${ext}`, content: b64(buf) });
          }
        }
        if (!attachments.length) return json({ error: 'No se pudo descargar ningún archivo', faltan }, 502);
        const filas = facturas.map(f => `<li>Factura ${String(f.numero || '').replace(/[<>&]/g, '')}${f.cliente ? ' — ' + String(f.cliente).replace(/[<>&]/g, '') : ''}</li>`).join('');
        const send = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
          body: JSON.stringify({
            from: env.ALERT_EMAIL_FROM || 'Flota Alertas <alertas@davidduque.com>',
            to: [env.ALERT_EMAIL_TO || 'david@davidduque.com'],
            subject: `Copia facturas DOCE DOCENAS SAS — ${facturas.map(f => f.numero).join(', ')}`,
            html: `<p>Copia de las facturas electrónicas emitidas (ZIP oficial DIAN con XML + PDF, y el PDF aparte):</p><ul>${filas}</ul>`,
            attachments,
          }),
        });
        const out = await send.json().catch(() => ({}));
        if (!send.ok) return json({ error: `Resend ${send.status}: ${JSON.stringify(out).slice(0, 300)}`, faltan }, 502);
        return json({ ok: true, id: out.id || null, adjuntos: attachments.map(a => a.filename), bytes: total, faltan });
      } catch (err) { return json({ error: err.message }, 500); }
    }

    // ── POST /api/aliaddo/factura-manual (?dryRun=1) — una factura por varios viajes (p.ej. una corrida) ──
    // body: { nit:'901101271-1', razon_social, email, concepto, valor, orden_compra?, medio_pago?, dias_credito?, op_id? }
    if (request.method === 'POST' && url.pathname === '/api/aliaddo/factura-manual') {
      try {
        const body = await request.json().catch(() => ({}));
        const token = env.ALIADDO_API_KEY || env.aliaddo || env.ALIADDO;
        const hoy = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
        const dias = Math.min(Math.max(parseInt(body.dias_credito) || 30, 1), 120);
        const dueDate = new Date(Date.parse(hoy + 'T00:00:00Z') + dias * 86400000).toISOString().slice(0, 10);
        const aliOpts = { dueDate, hoy, branchId: env.ALIADDO_BRANCH_ID, itemFletesCode: env.ITEM_FLETES_CODE, emisorNit: env.EMISOR_NIT };

        // Simulación: arma la factura completa SIN enviarla, sin crear cliente y sin tocar la base
        if (url.searchParams.get('dryRun') === '1') {
          const sim = await facturaManualAliaddo(token, body, { ...aliOpts, dryRun: true });
          return json(sim.error ? { ok: false, dryRun: true, error: sim.error, motivo: sim.motivo || null, cliente: sim.cliente || null } : sim, sim.error ? 400 : 200);
        }

        // Bloqueo anti-doble emisión por clave de operación (explícita o derivada de nit+valor+concepto+día)
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS facturas_manuales (
          id INTEGER PRIMARY KEY AUTOINCREMENT, op_id TEXT UNIQUE NOT NULL, nit TEXT, razon_social TEXT,
          valor REAL, concepto TEXT, email TEXT, estado TEXT DEFAULT 'en_proceso', numero TEXT, cufe TEXT,
          invoice_id TEXT, state_dian TEXT, url_pdf TEXT, error TEXT, usuario TEXT,
          creado_en TEXT DEFAULT (datetime('now','-5 hours')), actualizado_en TEXT)`).run();
        const opId = String(body.op_id || `manual:${String(body.nit || '').replace(/\D/g, '')}:${Math.round(Number(body.valor) || 0)}:${hoy}:${String(body.concepto || '').trim().toLowerCase()}`).slice(0, 300);
        const ins = await env.DB.prepare('INSERT OR IGNORE INTO facturas_manuales (op_id, nit, razon_social, valor, concepto, email, usuario) VALUES (?,?,?,?,?,?,?)')
          .bind(opId, body.nit || null, body.razon_social || null, Math.round(Number(body.valor) || 0), body.concepto || null, body.email || null, authUser ? authUser.email : null).run();
        if (!ins.meta.changes) {
          const prev = await env.DB.prepare('SELECT estado, numero FROM facturas_manuales WHERE op_id = ?').bind(opId).first();
          // Solo se permite reintentar si el intento anterior fue RECHAZADO de forma confirmada
          const reabre = prev && prev.estado === 'error'
            ? await env.DB.prepare("UPDATE facturas_manuales SET estado='en_proceso', error=NULL, actualizado_en=datetime('now','-5 hours') WHERE op_id=? AND estado='error'").bind(opId).run()
            : null;
          if (!reabre || !reabre.meta.changes) {
            return json({ error: prev && prev.numero ? `Esta factura ya fue emitida (No. ${prev.numero}).` : 'Esta factura ya está en proceso o pendiente de verificar en Aliaddo; no se reenvía para no duplicarla.', duplicada: true, estado: prev ? prev.estado : null }, 409);
          }
        }

        const r = await facturaManualAliaddo(token, body, aliOpts);
        if (r.error) {
          await env.DB.prepare("UPDATE facturas_manuales SET estado=?, error=?, actualizado_en=datetime('now','-5 hours') WHERE op_id=?")
            .bind(r.indeterminado ? 'verificar' : 'error', String(r.error).slice(0, 500), opId).run();
          return json({ error: r.error, indeterminado: !!r.indeterminado, motivo: r.motivo || null }, r.indeterminado ? 502 : 400);
        }
        await env.DB.prepare("UPDATE facturas_manuales SET estado='emitida', numero=?, cufe=?, invoice_id=?, state_dian=?, url_pdf=?, actualizado_en=datetime('now','-5 hours') WHERE op_id=?")
          .bind(r.numero || null, r.cufe || null, r.invoice_id || null, r.state_dian || null, r.url_pdf || null, opId).run();
        const email = await enviarEmailFactura(env, token, r.invoice_id);
        return json({ ok: true, numero: r.numero, cufe: r.cufe, invoice_id: r.invoice_id, state_dian: r.state_dian, motivo_dian: r.motivo_dian, url_pdf: r.url_pdf, op_id: opId, email });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/viajes/:id/datos-factura ────────────────────
    if (request.method === 'GET' && url.pathname.match(/^\/api\/viajes\/\d+\/datos-factura$/)) {
      try {
        const id = parseInt(url.pathname.split('/')[3]);
        if (!id) return json({ error: 'ID inválido' }, 400);

        const vj = await env.DB.prepare('SELECT * FROM viajes WHERE id = ?').bind(id).first();
        if (!vj) return json({ error: 'Viaje no encontrado' }, 404);

        return json({
          ok: true,
          factura: {
            emisor: { nombre: env.EMISOR_NOMBRE, nit: env.EMISOR_NIT },
            cliente: { nombre: vj.empresa_carga, nit: vj.empresa_carga_nit },
            concepto: 'Servicio de transporte de carga - Manifiesto ' + vj.numero_manifiesto + ' (' + vj.origen + ' - ' + vj.destino + ')',
            valor: vj.valor_flete,
            retefuente: vj.retefuente,
            fecha: vj.fecha_viaje,
            numero_manifiesto: vj.numero_manifiesto,
            proveedor_facturacion: 'Aliaddo'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/viajes/:id/gastos-candidatos ────────────────
    // Devuelve gastos ya enlazados al viaje + candidatos (sin viaje, mismo
    // vehículo, fecha ±10 días). DEBE ir antes de PATCH/DELETE /api/viajes/:id.
    if (request.method === 'GET' && url.pathname.match(/^\/api\/viajes\/\d+\/gastos-candidatos$/)) {
      try {
        const id = parseInt(url.pathname.split('/')[3]);
        if (!id) return json({ error: 'ID inválido' }, 400);

        const vj = await env.DB.prepare('SELECT id, numero, numero_manifiesto, vehiculo, fecha_viaje, valor_flete, comision_conductor FROM viajes WHERE id = ?').bind(id).first();
        if (!vj) return json({ error: 'Viaje no encontrado' }, 404);

        const enlazadosRes = await env.DB.prepare(
          'SELECT id, numero, fecha, proveedor_nombre, categoria, total FROM gastos WHERE viaje_id = ? ORDER BY fecha'
        ).bind(id).all();

        const candidatosRes = await env.DB.prepare(
          `SELECT id, numero, fecha, proveedor_nombre, categoria, total
             FROM gastos
            WHERE viaje_id IS NULL
              AND vehiculo = ?
              AND fecha BETWEEN date(?, '-10 days') AND date(?, '+10 days')
            ORDER BY fecha`
        ).bind(vj.vehiculo, vj.fecha_viaje, vj.fecha_viaje).all();

        return json({
          ok: true,
          viaje: vj,
          enlazados: enlazadosRes.results || [],
          candidatos: candidatosRes.results || []
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/viajes/:id/enlazar-gastos ──────────────────
    // body { enlazar: [ids], desenlazar: [ids] }. DEBE ir antes de
    // PATCH/DELETE /api/viajes/:id.
    if (request.method === 'POST' && url.pathname.match(/^\/api\/viajes\/\d+\/enlazar-gastos$/)) {
      try {
        const id = parseInt(url.pathname.split('/')[3]);
        if (!id) return json({ error: 'ID inválido' }, 400);

        const vj = await env.DB.prepare('SELECT id FROM viajes WHERE id = ?').bind(id).first();
        if (!vj) return json({ error: 'Viaje no encontrado' }, 404);

        const body = await request.json();
        const enlazar = Array.isArray(body.enlazar) ? body.enlazar.map(Number).filter(Boolean) : [];
        const desenlazar = Array.isArray(body.desenlazar) ? body.desenlazar.map(Number).filter(Boolean) : [];

        const stmts = [];
        if (enlazar.length > 0) {
          const ph = enlazar.map(() => '?').join(',');
          stmts.push(
            env.DB.prepare(`UPDATE gastos SET viaje_id = ? WHERE id IN (${ph})`).bind(id, ...enlazar)
          );
        }
        if (desenlazar.length > 0) {
          const ph = desenlazar.map(() => '?').join(',');
          stmts.push(
            env.DB.prepare(`UPDATE gastos SET viaje_id = NULL WHERE id IN (${ph}) AND viaje_id = ?`).bind(...desenlazar, id)
          );
        }
        if (stmts.length > 0) await env.DB.batch(stmts);

        return json({ ok: true, enlazados: enlazar.length, desenlazados: desenlazar.length });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PATCH /api/viajes/:id ────────────────────────────────
    if (request.method === 'PATCH' && url.pathname.match(/^\/api\/viajes\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const body = await request.json();
        const allowed = ['estado_cobro', 'valor_cobrado', 'fecha_cobro',
                         'estado_factura', 'numero_factura', 'fecha_factura',
                         'valor_flete', 'anticipo', 'saldo_a_cobrar',
                         'empresa_carga', 'empresa_carga_nit', 'vehiculo',
                         'fecha_viaje', 'notas', 'comision_conductor'];
        const sets = [];
        const vals = [];
        for (const k of allowed) {
          if (k in body) {
            sets.push(`${k} = ?`);
            vals.push(body[k]);
          }
        }
        if (sets.length === 0) return json({ error: 'Sin campos para actualizar' }, 400);

        sets.push("actualizado_en = datetime('now')");
        vals.push(id);

        await env.DB.prepare(`UPDATE viajes SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/viajes/:id ───────────────────────────────
    if (request.method === 'DELETE' && url.pathname.match(/^\/api\/viajes\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const row = await env.DB.prepare('SELECT id, numero, archivo_r2 FROM viajes WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Viaje no encontrado' }, 404);

        if (row.archivo_r2) {
          try { await env.BUCKET.delete(row.archivo_r2); } catch {}
        }

        await env.DB.prepare('UPDATE gastos SET viaje_id = NULL WHERE viaje_id = ?').bind(id).run();
        await env.DB.prepare('DELETE FROM viajes WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // AUDITORÍA DE PLANILLA MENSUAL (sistema vs declarado por conductor)
    // ════════════════════════════════════════════════════════════════════

    // ── POST /api/planilla-auditoria ─────────────────────────
    // Reemplaza TODAS las filas declaradas de un vehiculo+mes.
    // body { vehiculo, mes, filas: [ {...} ] }
    if (request.method === 'POST' && url.pathname === '/api/planilla-auditoria') {
      try {
        const body = await request.json();
        const { vehiculo, mes, filas } = body;
        if (!vehiculo) return json({ error: 'Falta vehiculo' }, 400);
        if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return json({ error: 'Falta mes (formato YYYY-MM)' }, 400);
        if (!Array.isArray(filas)) return json({ error: 'Se espera { filas: [...] }' }, 400);

        const ahora = new Date().toISOString();
        const stmts = [
          env.DB.prepare('DELETE FROM planilla_auditoria WHERE vehiculo = ? AND mes = ?').bind(vehiculo, mes)
        ];
        const insert = env.DB.prepare(`
          INSERT INTO planilla_auditoria
            (vehiculo, mes, fecha, destino, empresa_carga, numero_manifiesto,
             valor_flete, anticipo, gastos, comision_conductor, saldo_a_cobrar,
             es_cierre, concepto_cierre, archivo_r2, usuario, notas, creado_en, actualizado_en)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `);
        for (const f of filas) {
          stmts.push(insert.bind(
            vehiculo, mes,
            f.fecha || null, f.destino || null, f.empresa_carga || null,
            f.numero_manifiesto || null,
            f.valor_flete || 0, f.anticipo || 0, f.gastos || 0,
            f.comision_conductor || 0, f.saldo_a_cobrar || 0,
            f.es_cierre ? 1 : 0, f.concepto_cierre || null,
            f.archivo_r2 || null, f.usuario || (authUser ? authUser.email : null),
            f.notas || null, ahora, ahora
          ));
        }
        await env.DB.batch(stmts);
        return json({ ok: true, insertados: filas.length });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/planilla-auditoria?vehiculo=&mes= ───────────
    if (request.method === 'GET' && url.pathname === '/api/planilla-auditoria') {
      try {
        const vehiculo = url.searchParams.get('vehiculo');
        const mes = url.searchParams.get('mes');
        if (!vehiculo) return json({ error: 'Falta vehiculo' }, 400);
        if (!mes) return json({ error: 'Falta mes' }, 400);

        const result = await env.DB.prepare(
          'SELECT * FROM planilla_auditoria WHERE vehiculo = ? AND mes = ? ORDER BY es_cierre, fecha'
        ).bind(vehiculo, mes).all();
        return json({ ok: true, filas: result.results || [] });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/planilla-auditoria/:id ───────────────────
    if (request.method === 'DELETE' && url.pathname.match(/^\/api\/planilla-auditoria\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);
        await env.DB.prepare('DELETE FROM planilla_auditoria WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/auditoria?vehiculo=&mes= ────────────────────
    // Comparación lado a lado: SISTEMA (viajes + gastos enlazados) vs DECLARADO (planilla_auditoria).
    if (request.method === 'GET' && url.pathname === '/api/auditoria') {
      try {
        const vehiculo = url.searchParams.get('vehiculo');
        const mes = url.searchParams.get('mes');
        if (!vehiculo) return json({ error: 'Falta vehiculo' }, 400);
        if (!mes || !/^\d{4}-\d{2}$/.test(mes)) return json({ error: 'Falta mes (formato YYYY-MM)' }, 400);

        // ── LADO SISTEMA: viajes del mes + gastos enlazados por viaje_id ──
        const viajesRes = await env.DB.prepare(
          'SELECT * FROM viajes WHERE vehiculo = ? AND fecha_viaje LIKE ? ORDER BY fecha_viaje ASC, id ASC'
        ).bind(vehiculo, `${mes}%`).all();
        const viajes = viajesRes.results || [];

        // Total de gastos por viaje (una sola query agregada — misma técnica que GET /api/viajes)
        const gRes = await env.DB.prepare(
          'SELECT viaje_id, COALESCE(SUM(total),0) as tg FROM gastos WHERE viaje_id IS NOT NULL GROUP BY viaje_id'
        ).all();
        const gastosPorViaje = {};
        for (const row of (gRes.results || [])) gastosPorViaje[row.viaje_id] = row.tg;

        const sistemaTotales = { flete: 0, anticipo: 0, gastos: 0, comision: 0, saldo: 0, utilidad: 0 };
        const sistemaFilas = viajes.map(vj => {
          const tg = gastosPorViaje[vj.id] || 0;
          const flete = vj.valor_flete || 0;
          const anticipo = vj.anticipo || 0;
          const comision = vj.comision_conductor || 0;
          const saldo = vj.saldo_a_cobrar || 0;
          const utilidad = flete - tg - comision;
          sistemaTotales.flete += flete;
          sistemaTotales.anticipo += anticipo;
          sistemaTotales.gastos += tg;
          sistemaTotales.comision += comision;
          sistemaTotales.saldo += saldo;
          sistemaTotales.utilidad += utilidad;
          return {
            id: vj.id,
            numero_manifiesto: vj.numero_manifiesto,
            fecha: vj.fecha_viaje,
            destino: vj.destino,
            empresa_carga: vj.empresa_carga,
            valor_flete: flete,
            anticipo,
            comision_conductor: comision,
            gastos: tg,
            saldo_a_cobrar: saldo,
            utilidad
          };
        });

        // ── LADO DECLARADO: planilla_auditoria ──
        const declRes = await env.DB.prepare(
          'SELECT * FROM planilla_auditoria WHERE vehiculo = ? AND mes = ? ORDER BY es_cierre, fecha'
        ).bind(vehiculo, mes).all();
        const declaradoTodas = declRes.results || [];
        const declaradoViajes = declaradoTodas.filter(f => !f.es_cierre);
        const cierre = declaradoTodas.filter(f => f.es_cierre);

        const declaradoTotales = { flete: 0, anticipo: 0, gastos: 0, comision: 0, saldo: 0 };
        for (const f of declaradoViajes) {
          declaradoTotales.flete += f.valor_flete || 0;
          declaradoTotales.anticipo += f.anticipo || 0;
          declaradoTotales.gastos += f.gastos || 0;
          declaradoTotales.comision += f.comision_conductor || 0;
          declaradoTotales.saldo += f.saldo_a_cobrar || 0;
        }

        // ── COMPARACIÓN: indexar por numero_manifiesto normalizado ──
        const norm = m => (m || '').toString().trim();
        const sisPorMan = {};
        for (const s of sistemaFilas) {
          const k = norm(s.numero_manifiesto);
          if (k) sisPorMan[k] = s;
        }
        const decPorMan = {};
        for (const d of declaradoViajes) {
          const k = norm(d.numero_manifiesto);
          if (k) decPorMan[k] = d;
        }

        const manifiestos = new Set([...Object.keys(sisPorMan), ...Object.keys(decPorMan)]);
        const comparacion = [];
        const resumen = {
          total_manifiestos: 0, ok: 0, difieren: 0, solo_sistema: 0, solo_declarado: 0,
          dif_total_flete: 0, dif_total_gastos: 0, dif_total_saldo: 0
        };

        for (const man of manifiestos) {
          const s = sisPorMan[man] || null;
          const d = decPorMan[man] || null;
          const sistema = s ? {
            flete: s.valor_flete || 0, anticipo: s.anticipo || 0, gastos: s.gastos || 0,
            comision: s.comision_conductor || 0, saldo: s.saldo_a_cobrar || 0
          } : null;
          const declarado = d ? {
            flete: d.valor_flete || 0, anticipo: d.anticipo || 0, gastos: d.gastos || 0,
            comision: d.comision_conductor || 0, saldo: d.saldo_a_cobrar || 0
          } : null;

          const diffs = {
            flete: (declarado?.flete || 0) - (sistema?.flete || 0),
            anticipo: (declarado?.anticipo || 0) - (sistema?.anticipo || 0),
            gastos: (declarado?.gastos || 0) - (sistema?.gastos || 0),
            comision: (declarado?.comision || 0) - (sistema?.comision || 0),
            saldo: (declarado?.saldo || 0) - (sistema?.saldo || 0)
          };

          let estado;
          if (!sistema) estado = 'solo_declarado';
          else if (!declarado) estado = 'solo_sistema';
          else {
            const algunaDif = diffs.flete !== 0 || diffs.anticipo !== 0 || diffs.gastos !== 0
                           || diffs.comision !== 0 || diffs.saldo !== 0;
            estado = algunaDif ? 'difiere' : 'ok';
          }

          resumen.total_manifiestos++;
          if (estado === 'ok') resumen.ok++;
          else if (estado === 'difiere') resumen.difieren++;
          else if (estado === 'solo_sistema') resumen.solo_sistema++;
          else if (estado === 'solo_declarado') resumen.solo_declarado++;
          if (estado === 'difiere') {
            resumen.dif_total_flete += diffs.flete;
            resumen.dif_total_gastos += diffs.gastos;
            resumen.dif_total_saldo += diffs.saldo;
          }

          comparacion.push({
            numero_manifiesto: man,
            fecha: (s && s.fecha) || (d && d.fecha) || null,
            destino: (s && s.destino) || (d && d.destino) || null,
            sistema,
            declarado,
            diffs,
            estado
          });
        }

        comparacion.sort((a, b) => (a.fecha || '').localeCompare(b.fecha || ''));

        return json({
          ok: true,
          vehiculo,
          mes,
          sistema: { filas: sistemaFilas, totales: sistemaTotales },
          declarado: { filas: declaradoViajes, totales: declaradoTotales, cierre },
          comparacion,
          resumen
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/export-contadora?mes=YYYY-MM ────────────────
    if (request.method === 'GET' && url.pathname === '/api/export-contadora') {
      try {
        const mes = url.searchParams.get('mes');
        if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
          return json({ error: 'Parámetro mes requerido (formato YYYY-MM)' }, 400);
        }

        const [viajesRes, gastosRes] = await Promise.all([
          env.DB.prepare("SELECT * FROM viajes WHERE fecha_viaje LIKE ? ORDER BY fecha_viaje ASC, id ASC")
            .bind(`${mes}%`).all(),
          env.DB.prepare("SELECT * FROM gastos WHERE fecha LIKE ? ORDER BY fecha ASC, id ASC")
            .bind(`${mes}%`).all()
        ]);

        const result = generarReporteContadora(
          viajesRes.results || [],
          gastosRes.results || [],
          mes,
          {
            nombre: env.EMISOR_NOMBRE || '(configurar EMISOR_NOMBRE)',
            nit: env.EMISOR_NIT || '(configurar EMISOR_NIT)'
          }
        );

        return new Response(result.content, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': result.contentType,
            'Content-Disposition': `attachment; filename="${result.filename}"`,
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/export-resumen?anio=YYYY ────────────────────
    // RESUMEN maestro para la contadora: por camión × mes × concepto
    // (ingresos flete, retenciones, anticipo, CxC, gastos por categoría, comisión).
    if (request.method === 'GET' && url.pathname === '/api/export-resumen') {
      try {
        const anioP = url.searchParams.get('anio');
        const anio = /^\d{4}$/.test(anioP || '') ? anioP : String(new Date().getFullYear());
        const CATS = ['Peajes','Combustible','Llantas','Aceites y lubricantes','Mantenimiento','Repuestos','Lavado','Parqueadero','Seguro','Impuestos','Tecnomecánica','GPS / Tecnología','Viáticos conductor','Documentos','Multas','Báscula','Cargue / Descargue','Administración','Misceláneos'];

        const [vAgg, gAgg] = await Promise.all([
          env.DB.prepare("SELECT vehiculo, substr(fecha_viaje,1,7) AS mes, COUNT(*) AS n, COALESCE(SUM(valor_flete),0) AS flete, COALESCE(SUM(retefuente),0) AS rtf, COALESCE(SUM(reteica),0) AS ica, COALESCE(SUM(anticipo),0) AS ant, COALESCE(SUM(saldo_a_cobrar),0) AS cxc, COALESCE(SUM(comision_conductor),0) AS com FROM viajes WHERE fecha_viaje LIKE ? GROUP BY vehiculo, mes").bind(`${anio}%`).all(),
          env.DB.prepare("SELECT vehiculo, substr(fecha,1,7) AS mes, categoria, COALESCE(SUM(total),0) AS t FROM gastos WHERE fecha LIKE ? GROUP BY vehiculo, mes, categoria").bind(`${anio}%`).all()
        ]);

        const filas = {};
        const nueva = (v, m) => { const o = { vehiculo: v, mes: m, n: 0, flete: 0, rtf: 0, ica: 0, ant: 0, cxc: 0, com: 0, cats: {} }; CATS.forEach(c => o.cats[c] = 0); return o; };
        for (const r of (vAgg.results || [])) {
          const k = `${r.vehiculo || '—'}|${r.mes || ''}`;
          const o = filas[k] || (filas[k] = nueva(r.vehiculo || '—', r.mes || ''));
          o.n += r.n; o.flete += r.flete; o.rtf += r.rtf; o.ica += r.ica; o.ant += r.ant; o.cxc += r.cxc; o.com += r.com;
        }
        for (const r of (gAgg.results || [])) {
          const k = `${r.vehiculo || '—'}|${r.mes || ''}`;
          const o = filas[k] || (filas[k] = nueva(r.vehiculo || '—', r.mes || ''));
          o.cats[CATS.includes(r.categoria) ? r.categoria : 'Misceláneos'] += r.t;
        }

        const num = (x) => String(Math.round((x || 0) * 100) / 100);
        const esc = (s) => { s = (s == null ? '' : String(s)); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const CAB = ['MES','VEHICULO','VIAJES','VALOR TOTAL','RETEFUENTE','ICA','ANTICIPO','CXC (SALDO)', ...CATS.map(c => c.toUpperCase()), 'COMISION CONDUCTOR','TOTAL GASTOS','UTILIDAD'];
        const filaCSV = (o) => {
          const totG = CATS.reduce((s, c) => s + (o.cats[c] || 0), 0);
          return [o.mes, o.vehiculo, o.n, num(o.flete), num(o.rtf), num(o.ica), num(o.ant), num(o.cxc), ...CATS.map(c => num(o.cats[c])), num(o.com), num(totG), num(o.flete - totG - o.com)].map(esc).join(';');
        };

        const porVeh = {};
        for (const k of Object.keys(filas)) { const o = filas[k]; (porVeh[o.vehiculo] = porVeh[o.vehiculo] || []).push(o); }

        const lineas = [];
        lineas.push(`RESUMEN ${anio} - ${env.EMISOR_NOMBRE || 'DOCE DOCENAS SAS'} NIT ${env.EMISOR_NIT || ''}`);
        lineas.push(CAB.map(esc).join(';'));
        const gran = nueva('TODOS', 'TOTAL ' + anio);
        for (const veh of Object.keys(porVeh).sort()) {
          const sub = nueva(veh, 'TOTAL');
          for (const o of porVeh[veh].sort((a, b) => a.mes.localeCompare(b.mes))) {
            lineas.push(filaCSV(o));
            sub.n += o.n; sub.flete += o.flete; sub.rtf += o.rtf; sub.ica += o.ica; sub.ant += o.ant; sub.cxc += o.cxc; sub.com += o.com;
            CATS.forEach(c => sub.cats[c] += o.cats[c]);
          }
          lineas.push(filaCSV(sub));
          gran.n += sub.n; gran.flete += sub.flete; gran.rtf += sub.rtf; gran.ica += sub.ica; gran.ant += sub.ant; gran.cxc += sub.cxc; gran.com += sub.com;
          CATS.forEach(c => gran.cats[c] += sub.cats[c]);
        }
        lineas.push(filaCSV(gran));

        return new Response('﻿' + lineas.join('\r\n'), {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="resumen-flota-${anio}.csv"`,
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/reporte ───────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/reporte') {
      try {
        const p     = url.searchParams;
        const desde = p.get('desde') || '2026-01-01';
        const hasta = p.get('hasta') || '2026-12-31';

        const result = await env.DB.prepare(
          'SELECT * FROM gastos WHERE fecha BETWEEN ? AND ? ORDER BY fecha DESC, id DESC'
        ).bind(desde, hasta).all();

        const registros = result.results || [];

        const pdfBytes = generateReport(registros, desde, hasta);

        return new Response(pdfBytes, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="Flota_Reporte_${desde}_${hasta}.pdf"`,
            'Cache-Control': 'no-cache'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/recurrentes ─────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/recurrentes') {
      try {
        const p    = url.searchParams;
        const mes  = parseInt(p.get('mes'))  || new Date().getMonth() + 1;
        const anio = parseInt(p.get('anio')) || new Date().getFullYear();
        const result = await checkRecurrentes(env.DB, mes, anio);
        return json({ ok: true, ...result });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // CENTRO DE CONTROL (panel de mando flota)
    // ════════════════════════════════════════════════════════════════════

    // ── GET /api/centro-control?mes=YYYY-MM ─────────────────────
    if (request.method === 'GET' && url.pathname === '/api/centro-control') {
      try {
        const now = new Date();
        let mes = url.searchParams.get('mes');
        if (!mes || !/^\d{4}-\d{2}$/.test(mes)) {
          mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        }
        const mesLike = `${mes}%`;
        const mesNum = parseInt(mes.slice(5, 7), 10);
        const anio   = parseInt(mes.slice(0, 4), 10);

        // ── KPIs ──────────────────────────────────────────────
        const [gastosMesRow, ingresosMesRow, saldosRow, pendPagoRow, numViajesRow] = await Promise.all([
          env.DB.prepare("SELECT COALESCE(SUM(total),0) AS v, COUNT(*) AS n FROM gastos WHERE fecha LIKE ?").bind(mesLike).first(),
          env.DB.prepare("SELECT COALESCE(SUM(valor_flete),0) AS v FROM viajes WHERE fecha_viaje LIKE ?").bind(mesLike).first(),
          env.DB.prepare("SELECT COALESCE(SUM(saldo_a_cobrar),0) AS v FROM viajes WHERE estado_cobro != 'cobrado'").first(),
          env.DB.prepare("SELECT COALESCE(SUM(total),0) AS v FROM gastos WHERE pagado_via IS NULL AND fecha LIKE ?").bind(mesLike).first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM viajes WHERE fecha_viaje LIKE ?").bind(mesLike).first()
        ]);

        const gastos_mes   = gastosMesRow.v || 0;
        const ingresos_mes = ingresosMesRow.v || 0;
        const kpis = {
          gastos_mes,
          ingresos_mes,
          utilidad_mes: ingresos_mes - gastos_mes,
          saldos_por_cobrar: saldosRow.v || 0,
          pendientes_pago: pendPagoRow.v || 0,
          num_viajes_mes: numViajesRow.n || 0,
          num_gastos_mes: gastosMesRow.n || 0
        };

        // ── ALERTAS / SEMÁFOROS ───────────────────────────────
        const [revRow, docEqRow, sinFactRow, sinCobrarRow] = await Promise.all([
          env.DB.prepare("SELECT COUNT(*) AS n FROM gastos WHERE estado = 'revision'").first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM gastos WHERE es_electronica = 0 AND (doc_equivalente IS NULL OR doc_equivalente = '')").first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM viajes WHERE estado_factura = 'pendiente'").first(),
          env.DB.prepare("SELECT COUNT(*) AS n FROM viajes WHERE estado_cobro != 'cobrado'").first()
        ]);

        let obligaciones_vencidas = 0;
        let obligaciones_proximas = 0;
        try {
          // checkRecurrentes para asegurar disponibilidad de la firma; se complementa
          // con las obligaciones registradas en D1 para vencidas/próximas.
          await checkRecurrentes(env.DB, mesNum, anio);
          const esMesActual = (mesNum === now.getMonth() + 1 && anio === now.getFullYear());
          const hoyDia = now.getDate();
          const obligs = await env.DB.prepare("SELECT * FROM obligaciones WHERE activo = 1").all();
          const gastosMesList = await env.DB.prepare(
            "SELECT proveedor_nit, proveedor_nombre FROM gastos WHERE fecha LIKE ?"
          ).bind(mesLike).all();
          const gmes = gastosMesList.results || [];
          let venc = 0, prox = 0;
          for (const ob of (obligs.results || [])) {
            let pagado = false;
            for (const g of gmes) {
              if (ob.proveedor_nit && g.proveedor_nit) {
                const a = ob.proveedor_nit.replace(/\D/g, '');
                const b = g.proveedor_nit.replace(/\D/g, '');
                if (a && b && b.startsWith(a.slice(0, 9))) { pagado = true; break; }
              }
              if (ob.nombre && g.proveedor_nombre) {
                const on = ob.nombre.toLowerCase();
                const gn = g.proveedor_nombre.toLowerCase();
                if (gn.includes(on) || on.includes(gn)) { pagado = true; break; }
              }
            }
            if (pagado) continue;
            const dl = ob.dia_limite || 0;
            if (esMesActual && dl > 0 && hoyDia > dl) venc++;
            else if (esMesActual && dl > 0 && (dl - hoyDia) <= 5) prox++;
            else if (!esMesActual && dl > 0) venc++;
          }
          obligaciones_vencidas = venc;
          obligaciones_proximas = prox;
        } catch (e) {
          obligaciones_vencidas = 0;
          obligaciones_proximas = 0;
        }

        const alertas = {
          gastos_revision: revRow.n || 0,
          doc_equivalente_pendiente: docEqRow.n || 0,
          viajes_sin_facturar: sinFactRow.n || 0,
          viajes_sin_cobrar: sinCobrarRow.n || 0,
          obligaciones_vencidas,
          obligaciones_proximas
        };

        // ── PRESUPUESTOS ──────────────────────────────────────
        const presRes = await env.DB.prepare("SELECT * FROM presupuestos WHERE activo = 1 ORDER BY ambito, referencia").all();
        const presupuestos = [];
        for (const p of (presRes.results || [])) {
          let gastado = 0;
          if (p.ambito === 'categoria') {
            const r = await env.DB.prepare("SELECT COALESCE(SUM(total),0) AS v FROM gastos WHERE categoria = ? AND fecha LIKE ?").bind(p.referencia, mesLike).first();
            gastado = r.v || 0;
          } else if (p.ambito === 'vehiculo') {
            const r = await env.DB.prepare("SELECT COALESCE(SUM(total),0) AS v FROM gastos WHERE vehiculo = ? AND fecha LIKE ?").bind(p.referencia, mesLike).first();
            gastado = r.v || 0;
          } else { // general
            gastado = gastos_mes;
          }
          const monto = p.monto || 0;
          const pct = monto > 0 ? Math.round((gastado / monto) * 100) : 0;
          const estado = pct > 100 ? 'excedido' : (pct >= 80 ? 'alerta' : 'ok');
          presupuestos.push({ id: p.id, ambito: p.ambito, referencia: p.referencia, monto, gastado, pct, estado, notas: p.notas || null });
        }

        // ── TENDENCIAS (últimos 6 meses) ──────────────────────
        const meses = [];
        for (let i = 5; i >= 0; i--) {
          const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
          meses.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
        }
        const minMes = meses[0];

        const [gastosPorMesRes, ingresosPorMesRes, porCatRes, porVehRes] = await Promise.all([
          env.DB.prepare("SELECT substr(fecha,1,7) AS m, COALESCE(SUM(total),0) AS v FROM gastos WHERE substr(fecha,1,7) >= ? GROUP BY m").bind(minMes).all(),
          env.DB.prepare("SELECT substr(fecha_viaje,1,7) AS m, COALESCE(SUM(valor_flete),0) AS v FROM viajes WHERE substr(fecha_viaje,1,7) >= ? GROUP BY m").bind(minMes).all(),
          env.DB.prepare("SELECT categoria, COALESCE(SUM(total),0) AS total FROM gastos WHERE fecha LIKE ? GROUP BY categoria ORDER BY total DESC LIMIT 10").bind(mesLike).all(),
          env.DB.prepare("SELECT vehiculo, COALESCE(SUM(total),0) AS total FROM gastos WHERE fecha LIKE ? GROUP BY vehiculo ORDER BY total DESC").bind(mesLike).all()
        ]);

        const gMap = {}; for (const r of (gastosPorMesRes.results || [])) gMap[r.m] = r.v;
        const iMap = {}; for (const r of (ingresosPorMesRes.results || [])) iMap[r.m] = r.v;

        const tendencias = {
          meses,
          gastos:   meses.map(m => gMap[m] || 0),
          ingresos: meses.map(m => iMap[m] || 0),
          por_categoria: (porCatRes.results || []).map(r => ({ categoria: r.categoria || 'Sin categoría', total: r.total })),
          por_vehiculo:  (porVehRes.results || []).map(r => ({ vehiculo: r.vehiculo || 'Sin vehículo', total: r.total }))
        };

        return json({ ok: true, mes, kpis, alertas, presupuestos, tendencias });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/presupuestos ───────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/presupuestos') {
      try {
        const result = await env.DB.prepare("SELECT * FROM presupuestos ORDER BY ambito, referencia").all();
        return json({ ok: true, presupuestos: result.results || [] });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/presupuestos ──────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/presupuestos') {
      try {
        const b = await request.json();
        if (!b.ambito || (b.monto === undefined || b.monto === null)) {
          return json({ error: 'ambito y monto son requeridos' }, 400);
        }
        if (!['categoria', 'vehiculo', 'general'].includes(b.ambito)) {
          return json({ error: 'ambito inválido' }, 400);
        }
        const referencia = b.ambito === 'general' ? null : (b.referencia || null);
        const result = await env.DB.prepare(
          "INSERT INTO presupuestos (ambito, referencia, monto, notas) VALUES (?,?,?,?)"
        ).bind(b.ambito, referencia, b.monto, b.notas || null).run();
        return json({ ok: true, id: result.meta?.last_row_id }, 201);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PUT /api/presupuestos/:id ───────────────────────────
    if (request.method === 'PUT' && url.pathname.match(/^\/api\/presupuestos\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        const b = await request.json();
        const sets = [];
        const vals = [];
        const allowed = ['monto', 'activo', 'notas'];
        for (const [k, v] of Object.entries(b)) {
          if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (!sets.length) return json({ error: 'Sin campos válidos' }, 400);
        sets.push("actualizado_en = CURRENT_TIMESTAMP");
        vals.push(id);
        await env.DB.prepare(`UPDATE presupuestos SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/presupuestos/:id ────────────────────────
    if (request.method === 'DELETE' && url.pathname.match(/^\/api\/presupuestos\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        await env.DB.prepare("DELETE FROM presupuestos WHERE id = ?").bind(id).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/tendencias ────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/tendencias') {
      try {
        const meses = parseInt(url.searchParams.get('meses') || '6');
        const limit = Math.min(Math.max(meses, 1), 24);

        const result = await env.DB.prepare(`
          SELECT strftime('%Y-%m', fecha) as mes,
                 categoria,
                 SUM(total) as total
          FROM gastos
          WHERE fecha >= date('now', '-${limit} months')
          GROUP BY mes, categoria
          ORDER BY mes
        `).all();

        const rows = result.results || [];

        const mesesMap = {};
        for (const row of rows) {
          if (!mesesMap[row.mes]) {
            mesesMap[row.mes] = { mes: row.mes, total: 0, categorias: {} };
          }
          mesesMap[row.mes].categorias[row.categoria] = row.total;
          mesesMap[row.mes].total += row.total;
        }

        const mesesArr = Object.values(mesesMap).sort((a, b) => a.mes.localeCompare(b.mes));

        return json({ ok: true, meses: mesesArr });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/comparativo ───────────────────────────────────
    // Compara dos meses: ?mes1=2026-03&mes2=2026-04
    if (request.method === 'GET' && url.pathname === '/api/comparativo') {
      try {
        const mes1 = url.searchParams.get('mes1');
        const mes2 = url.searchParams.get('mes2');
        if (!mes1 || !mes2) return json({ error: 'Parámetros mes1 y mes2 requeridos (formato YYYY-MM)' }, 400);
        if (!/^\d{4}-\d{2}$/.test(mes1) || !/^\d{4}-\d{2}$/.test(mes2)) {
          return json({ error: 'Formato inválido. Usar YYYY-MM' }, 400);
        }

        const desde1 = `${mes1}-01`;
        const hasta1 = `${mes1}-31`;
        const desde2 = `${mes2}-01`;
        const hasta2 = `${mes2}-31`;

        const [r1, r2] = await Promise.all([
          env.DB.prepare('SELECT categoria, SUM(total) as total, COUNT(*) as registros FROM gastos WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY categoria')
            .bind(desde1, hasta1).all(),
          env.DB.prepare('SELECT categoria, SUM(total) as total, COUNT(*) as registros FROM gastos WHERE fecha BETWEEN ? AND ? GROUP BY categoria ORDER BY categoria')
            .bind(desde2, hasta2).all()
        ]);

        const catMap = {};

        let granTotal1 = 0;
        let totalReg1 = 0;
        for (const row of (r1.results || [])) {
          if (!catMap[row.categoria]) catMap[row.categoria] = { mes1: 0, mes2: 0, reg1: 0, reg2: 0 };
          catMap[row.categoria].mes1 = row.total;
          catMap[row.categoria].reg1 = row.registros;
          granTotal1 += row.total;
          totalReg1 += row.registros;
        }

        let granTotal2 = 0;
        let totalReg2 = 0;
        for (const row of (r2.results || [])) {
          if (!catMap[row.categoria]) catMap[row.categoria] = { mes1: 0, mes2: 0, reg1: 0, reg2: 0 };
          catMap[row.categoria].mes2 = row.total;
          catMap[row.categoria].reg2 = row.registros;
          granTotal2 += row.total;
          totalReg2 += row.registros;
        }

        const categorias = Object.entries(catMap).map(([cat, v]) => {
          const diff = v.mes2 - v.mes1;
          const pct = v.mes1 !== 0 ? ((diff / Math.abs(v.mes1)) * 100) : (v.mes2 !== 0 ? 100 : 0);
          return {
            categoria: cat,
            mes1: v.mes1,
            mes2: v.mes2,
            registros_mes1: v.reg1,
            registros_mes2: v.reg2,
            diferencia: diff,
            porcentaje: Math.round(pct * 10) / 10
          };
        }).sort((a, b) => Math.abs(b.diferencia) - Math.abs(a.diferencia));

        const diffTotal = granTotal2 - granTotal1;
        const pctTotal = granTotal1 !== 0 ? Math.round(((diffTotal / Math.abs(granTotal1)) * 100) * 10) / 10 : 0;

        return json({
          ok: true,
          mes1,
          mes2,
          resumen: {
            total_mes1: granTotal1,
            total_mes2: granTotal2,
            diferencia: diffTotal,
            porcentaje: pctTotal,
            registros_mes1: totalReg1,
            registros_mes2: totalReg2,
            categorias_activas: categorias.length
          },
          categorias
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/estado-mes ──────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/estado-mes') {
      try {
        const mes  = parseInt(url.searchParams.get('mes'))  || new Date().getMonth() + 1;
        const anio = parseInt(url.searchParams.get('anio')) || new Date().getFullYear();

        const mesStr   = String(mes).padStart(2, '0');
        const desde    = `${anio}-${mesStr}-01`;
        const hastaDia = new Date(anio, mes, 0).getDate();
        const hasta    = `${anio}-${mesStr}-${String(hastaDia).padStart(2, '0')}`;

        // 1. Total gastos y monto del mes
        const resumen = await env.DB.prepare(
          'SELECT COUNT(*) as total_gastos, COALESCE(SUM(total),0) as total_monto FROM gastos WHERE fecha BETWEEN ? AND ?'
        ).bind(desde, hasta).first();

        // 2. Gastos en estado revision
        const revision = await env.DB.prepare(
          'SELECT COUNT(*) as count FROM gastos WHERE fecha BETWEEN ? AND ? AND estado = ?'
        ).bind(desde, hasta, 'revision').first();

        // 3. Días sin registro
        const ultimoReg = await env.DB.prepare(
          'SELECT fecha FROM gastos ORDER BY fecha DESC LIMIT 1'
        ).first();

        let dias_sin_registro = 0;
        if (ultimoReg && ultimoReg.fecha) {
          const ultimaFecha = new Date(ultimoReg.fecha + 'T12:00:00');
          const hoy = new Date();
          hoy.setHours(12, 0, 0, 0);
          dias_sin_registro = Math.floor((hoy - ultimaFecha) / (1000 * 60 * 60 * 24));
          if (dias_sin_registro < 0) dias_sin_registro = 0;
        }

        // 4. Obligaciones recurrentes faltantes (derivadas de las obligaciones activas)
        const recurrentes_faltantes = [];
        try {
          const obligs = await env.DB.prepare(
            "SELECT nombre, proveedor_nit, categoria FROM obligaciones WHERE activo = 1 AND frecuencia = 'mensual'"
          ).all();
          for (const ob of (obligs.results || [])) {
            const nitClean = (ob.proveedor_nit || '').replace(/\D/g, '');
            let found = null;
            if (nitClean) {
              found = await env.DB.prepare(
                "SELECT COUNT(*) as c FROM gastos WHERE fecha BETWEEN ? AND ? AND REPLACE(REPLACE(proveedor_nit,'-',''),' ','') LIKE ?"
              ).bind(desde, hasta, nitClean.slice(0, 9) + '%').first();
            }
            if (!found || found.c === 0) {
              recurrentes_faltantes.push({
                nit: ob.proveedor_nit,
                nombre: ob.nombre,
                categoria: ob.categoria
              });
            }
          }
        } catch { /* tabla obligaciones puede no existir aún */ }

        // 5. Construir alertas
        const alertas = [];

        if (revision.count > 0) {
          alertas.push({
            tipo: 'revision',
            nivel: 'yellow',
            mensaje: `${revision.count} gasto(s) en estado "revision" pendientes de confirmar`
          });
        }

        if (recurrentes_faltantes.length > 0) {
          const nombres = recurrentes_faltantes.map(r => r.nombre).join(', ');
          alertas.push({
            tipo: 'recurrentes',
            nivel: recurrentes_faltantes.length >= 3 ? 'red' : 'yellow',
            mensaje: `Falta(n) pago(s) recurrente(s): ${nombres}`
          });
        }

        if (dias_sin_registro > 7) {
          alertas.push({
            tipo: 'inactividad',
            nivel: dias_sin_registro > 14 ? 'red' : 'yellow',
            mensaje: `${dias_sin_registro} dias sin registrar gastos (ultimo: ${ultimoReg?.fecha || 'N/A'})`
          });
        }

        if (resumen.total_gastos === 0) {
          alertas.push({
            tipo: 'vacio',
            nivel: 'red',
            mensaje: `Sin gastos registrados en ${mesStr}/${anio}`
          });
        }

        let nivel_global = 'green';
        if (alertas.some(a => a.nivel === 'red')) nivel_global = 'red';
        else if (alertas.some(a => a.nivel === 'yellow')) nivel_global = 'yellow';

        return json({
          mes,
          anio,
          total_gastos: resumen.total_gastos,
          total_monto: resumen.total_monto,
          gastos_en_revision: revision.count,
          recurrentes_faltantes,
          dias_sin_registro,
          alertas,
          nivel_global
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // OBLIGACIONES (pagos recurrentes)
    // ════════════════════════════════════════════════════════════════════

    // ── GET /api/obligaciones ───────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/obligaciones') {
      try {
        const tipo   = url.searchParams.get('tipo');
        const activo = url.searchParams.get('activo');

        let q = 'SELECT * FROM obligaciones WHERE 1=1';
        const v = [];
        if (tipo)   { q += ' AND tipo = ?';   v.push(tipo); }
        if (activo !== null && activo !== undefined && activo !== '') {
          q += ' AND activo = ?'; v.push(parseInt(activo));
        }
        q += ' ORDER BY tipo ASC, dia_limite ASC, nombre ASC';

        const result = await env.DB.prepare(q).bind(...v).all();
        return json({ ok: true, obligaciones: result.results || [] });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/obligaciones/pendientes ─────────────────────
    if (request.method === 'GET' && url.pathname === '/api/obligaciones/pendientes') {
      try {
        const now   = new Date();
        const mes   = parseInt(url.searchParams.get('mes'))  || (now.getMonth() + 1);
        const anio  = parseInt(url.searchParams.get('anio')) || now.getFullYear();
        const mesStr = String(mes).padStart(2, '0');
        const desde  = `${anio}-${mesStr}-01`;
        const hastaDia = new Date(anio, mes, 0).getDate();
        const hasta  = `${anio}-${mesStr}-${String(hastaDia).padStart(2, '0')}`;
        const hoy    = now.getDate();
        const esMesActual = (mes === now.getMonth() + 1 && anio === now.getFullYear());

        const obligs = await env.DB.prepare(
          'SELECT * FROM obligaciones WHERE activo = 1 ORDER BY tipo ASC, dia_limite ASC'
        ).all();

        const gastosRes = await env.DB.prepare(
          'SELECT id, numero, proveedor_nit, proveedor_nombre, total, fecha, categoria FROM gastos WHERE fecha BETWEEN ? AND ?'
        ).bind(desde, hasta).all();
        const gastosMes = gastosRes.results || [];

        const pendientes = [];
        const pagadas = [];

        for (const ob of (obligs.results || [])) {
          let pagado = null;
          for (const g of gastosMes) {
            if (ob.proveedor_nit && g.proveedor_nit) {
              const obNitClean = ob.proveedor_nit.replace(/\D/g, '');
              const gNitClean  = g.proveedor_nit.replace(/\D/g, '');
              if (obNitClean && gNitClean && gNitClean.startsWith(obNitClean.slice(0, 9))) {
                pagado = g;
                break;
              }
            }
            if (!pagado && ob.proveedor_nombre && g.proveedor_nombre) {
              const obName = ob.proveedor_nombre.toLowerCase();
              const gName  = g.proveedor_nombre.toLowerCase();
              if (gName.includes(obName) || obName.includes(gName)) {
                pagado = g;
                break;
              }
            }
            if (!pagado && ob.nombre) {
              const obNombre = ob.nombre.toLowerCase();
              const gName = (g.proveedor_nombre || '').toLowerCase();
              if (gName.includes(obNombre) || obNombre.includes(gName)) {
                pagado = g;
                break;
              }
            }
          }

          const diaLimite = ob.dia_limite || 0;
          const diasRestantes = esMesActual ? (diaLimite - hoy) : null;
          const vencido = esMesActual && diaLimite > 0 && hoy > diaLimite;

          const item = {
            ...ob,
            dias_restantes: diasRestantes,
            vencido: vencido && !pagado
          };

          if (pagado) {
            pagadas.push({ ...item, gasto: pagado });
          } else {
            pendientes.push(item);
          }
        }

        return json({
          ok: true,
          mes, anio,
          pendientes,
          pagadas,
          total_pendientes: pendientes.length,
          total_pagadas: pagadas.length
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/obligaciones ──────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/obligaciones') {
      try {
        const b = await request.json();
        if (!b.nombre || !b.tipo || !b.frecuencia) {
          return json({ error: 'nombre, tipo y frecuencia son requeridos' }, 400);
        }

        const result = await env.DB.prepare(`
          INSERT INTO obligaciones (nombre, descripcion, tipo, categoria, proveedor_nit, proveedor_nombre, frecuencia, dia_limite, valor_estimado, medio_pago, notas)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          b.nombre, b.descripcion || null, b.tipo, b.categoria || null,
          b.proveedor_nit || null, b.proveedor_nombre || null,
          b.frecuencia, b.dia_limite || null, b.valor_estimado || null,
          b.medio_pago || null, b.notas || null
        ).run();

        return json({ ok: true, id: result.meta?.last_row_id }, 201);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PUT /api/obligaciones/:id ───────────────────────────
    if (request.method === 'PUT' && url.pathname.match(/^\/api\/obligaciones\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        const b = await request.json();

        const sets = [];
        const vals = [];
        const allowed = ['nombre','descripcion','tipo','categoria','proveedor_nit','proveedor_nombre','frecuencia','dia_limite','valor_estimado','medio_pago','activo','notas'];
        for (const [k, v] of Object.entries(b)) {
          if (allowed.includes(k)) { sets.push(`${k} = ?`); vals.push(v); }
        }
        if (!sets.length) return json({ error: 'Sin campos validos' }, 400);

        vals.push(id);
        await env.DB.prepare(`UPDATE obligaciones SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/obligaciones/:id ────────────────────────
    if (request.method === 'DELETE' && url.pathname.match(/^\/api\/obligaciones\/\d+$/)) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        await env.DB.prepare('UPDATE obligaciones SET activo = 0 WHERE id = ?').bind(id).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/analisis-ia ──────────────────────────────────
    // Claude analiza el historial de gastos y sugiere recurrentes/pendientes
    if (request.method === 'GET' && url.pathname === '/api/analisis-ia') {
      try {
        const gastos = await env.DB.prepare(`
          SELECT proveedor_nit, proveedor_nombre, categoria, fecha, total, concepto, numero_documento, vehiculo
          FROM gastos
          WHERE fecha >= date('now', '-6 months')
          ORDER BY fecha DESC
        `).all();

        const obligs = await env.DB.prepare('SELECT nombre, proveedor_nit FROM obligaciones WHERE activo = 1').all().catch(() => ({ results: [] }));

        const now = new Date();
        const mesActual = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;

        const estesMes = await env.DB.prepare(`
          SELECT proveedor_nit, proveedor_nombre, categoria, total, fecha, vehiculo
          FROM gastos
          WHERE strftime('%Y-%m', fecha) = ?
        `).bind(mesActual).all();

        // Agrupar por proveedor+categoría para reducir tokens
        const agrupado = {};
        for (const g of (gastos.results || [])) {
          const key = `${g.proveedor_nit||''}|${g.proveedor_nombre}|${g.categoria}`;
          if (!agrupado[key]) agrupado[key] = { proveedor: g.proveedor_nombre, nit: g.proveedor_nit, cat: g.categoria, meses: new Set(), total: 0, n: 0 };
          agrupado[key].meses.add(g.fecha?.slice(0,7));
          agrupado[key].total += g.total || 0;
          agrupado[key].n++;
        }
        const resumen = Object.values(agrupado).map(g => ({
          proveedor: g.proveedor, nit: g.nit, cat: g.cat, meses: g.meses.size, veces: g.n, total: Math.round(g.total), prom: Math.round(g.total/g.n)
        })).sort((a,b) => b.veces - a.veces);

        const prompt = `Eres un analista financiero. Analiza este resumen agrupado de gastos de una flota de tractomulas (transporte de carga en Colombia).

RESUMEN AGRUPADO últimos 6 meses (${gastos.results.length} registros, ${resumen.length} proveedores):
${JSON.stringify(resumen.slice(0, 50), null, 0)}

OBLIGACIONES YA REGISTRADAS (no las repitas):
${JSON.stringify(obligs.results, null, 0)}

GASTOS DE ESTE MES (${mesActual}):
${JSON.stringify(estesMes.results, null, 0)}

Analiza patrones y responde SOLO con JSON válido:

{
  "recurrentes_sugeridos": [
    {
      "nombre": "nombre descriptivo",
      "tipo": "empresa | personal",
      "categoria": "categoría del sistema",
      "proveedor_nombre": "nombre",
      "proveedor_nit": "NIT si se conoce",
      "frecuencia": "mensual | quincenal | bimestral | trimestral | semestral | anual",
      "dia_limite": 15,
      "valor_estimado": 500000,
      "razon": "por qué crees que es recurrente (ej: aparece 4 de 6 meses)"
    }
  ],
  "pendientes_este_mes": [
    {
      "nombre": "qué falta por pagar",
      "tipo": "empresa | personal",
      "categoria": "categoría",
      "valor_estimado": 500000,
      "razon": "se pagó los últimos N meses pero no este mes"
    }
  ],
  "alertas": [
    "Texto libre con observaciones: gastos inusuales, aumentos, patrones preocupantes, etc."
  ],
  "resumen": "Resumen ejecutivo de 2-3 frases sobre la salud financiera de la flota"
}

REGLAS:
- Solo sugiere recurrentes que NO estén en la lista de obligaciones existentes
- Para pendientes, solo incluye los que se pagaron al menos 3 de los últimos 6 meses y NO aparecen este mes
- Categorías válidas: Combustible, Peajes, Llantas, Mantenimiento, Repuestos, Aceites y lubricantes, Lavado, Parqueadero, Seguro, Impuestos, Tecnomecánica, GPS / Tecnología, Viáticos conductor, Documentos, Multas, Báscula, Cargue / Descargue, Administración, Misceláneos
- Tipos: "empresa" para gastos operativos de la flota, "personal" para gastos personales`;

        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01'
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1200,
            messages: [{ role: 'user', content: prompt }]
          })
        });

        const aiData = await res.json();
        const raw = aiData.content?.find(b => b.type === 'text')?.text || '{}';

        let analisis;
        try {
          analisis = JSON.parse(raw.replace(/```json|```/g, '').trim());
        } catch {
          return json({ ok: false, error: 'Error parseando respuesta IA', raw }, 500);
        }

        return json({ ok: true, ...analisis, total_gastos_analizados: gastos.results.length });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/enviar-alerta ─────────────────────────────
    // Trigger manual de la alerta por email (para probar)
    if (request.method === 'GET' && url.pathname === '/api/enviar-alerta') {
      try {
        await this.scheduled({}, env, {});
        return json({ ok: true, message: 'Alerta enviada (si hay pendientes)' });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/sugerencia-aceptar ────────────────────────
    // Acepta una sugerencia de la IA y la crea como obligación
    if (request.method === 'POST' && url.pathname === '/api/sugerencia-aceptar') {
      try {
        const body = await request.json();
        await env.DB.prepare(`
          INSERT INTO obligaciones (nombre, tipo, categoria, proveedor_nit, proveedor_nombre, frecuencia, dia_limite, valor_estimado, notas)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          body.nombre, body.tipo || 'empresa', body.categoria || 'Misceláneos',
          body.proveedor_nit || null, body.proveedor_nombre || null,
          body.frecuencia || 'mensual', body.dia_limite || null,
          body.valor_estimado || null, 'Sugerido por IA: ' + (body.razon || '')
        ).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ══════════════════════════════════════════════════════
    // AUTH ENDPOINTS
    // ══════════════════════════════════════════════════════

    // ── POST /api/auth/register ─────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/register') {
      try {
        const body = await request.json();
        const { email, password, nombre } = body;
        if (!email || !password) return json({ error: 'Email y password requeridos' }, 400);
        if (password.length < 8) return json({ error: 'Password mínimo 8 caracteres' }, 400);

        const count = await env.DB.prepare('SELECT COUNT(*) as n FROM users').first();
        const hasUsers = count?.n > 0;
        const adminToken = request.headers.get('x-admin-token');
        const isAdmin = env.ADMIN_SETUP_TOKEN && adminToken === env.ADMIN_SETUP_TOKEN;

        if (hasUsers && !isAdmin) {
          return json({ error: 'Registro deshabilitado. Contacta al administrador.' }, 403);
        }

        const exists = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (exists) return json({ error: 'Email ya registrado' }, 409);

        const passwordHash = await hashPassword(password);
        const result = await env.DB.prepare(
          'INSERT INTO users (email, password_hash, nombre, rol) VALUES (?, ?, ?, ?)'
        ).bind(email, passwordHash, nombre || null, 'admin').run();

        return json({ ok: true, id: result.meta?.last_row_id, email });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/auth/login ────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/login') {
      try {
        const { email, password } = await request.json();
        if (!email || !password) return json({ error: 'Credenciales requeridas' }, 400);

        const user = await env.DB.prepare(
          'SELECT id, email, password_hash, totp_secret, totp_verified, activo, nombre, rol FROM users WHERE email = ?'
        ).bind(email).first();

        if (!user || user.activo === 0) return json({ error: 'Credenciales inválidas' }, 401);
        if (user.password_hash === 'PENDING') return json({ error: 'Usuario pendiente de setup' }, 403);

        const valid = await verifyPassword(password, user.password_hash);
        if (!valid) return json({ error: 'Credenciales inválidas' }, 401);

        // 2FA deshabilitado: crear session full inmediatamente
        const { token, expires_at } = await createSession(env.DB, user.id, 'full');
        await env.DB.prepare("UPDATE users SET ultimo_login = datetime('now') WHERE id = ?").bind(user.id).run();

        return json({
          ok: true,
          session_token: token,
          expires_at,
          user: { email: user.email, nombre: user.nombre, rol: user.rol },
          // Compat con frontends viejos
          temp_token: token,
          needs_setup: false
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/auth/setup-2fa ────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/setup-2fa') {
      try {
        const user = await verifyRequest(request, env, { requireFull: false });
        if (!user) return json({ error: 'Token temporal inválido' }, 401);
        if (user.session_tipo !== 'temp') return json({ error: 'Ya autenticado' }, 400);

        const secret = generateTotpSecret();
        await env.DB.prepare(
          'UPDATE users SET totp_secret = ?, totp_verified = 0 WHERE id = ?'
        ).bind(secret, user.id).run();

        const uri = totpUri(user.email, secret, 'Flota');
        return json({
          ok: true,
          secret,
          otpauth_uri: uri,
          qr_url: qrCodeUrl(uri)
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/auth/verify-2fa ───────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/verify-2fa') {
      try {
        const user = await verifyRequest(request, env, { requireFull: false });
        if (!user) return json({ error: 'Token temporal inválido' }, 401);
        if (user.session_tipo !== 'temp') return json({ error: 'Sesión ya activa' }, 400);

        const { code } = await request.json();
        if (!code) return json({ error: 'Código requerido' }, 400);

        const row = await env.DB.prepare(
          'SELECT totp_secret FROM users WHERE id = ?'
        ).bind(user.id).first();

        if (!row?.totp_secret) return json({ error: 'TOTP no configurado' }, 400);

        const valid = await verifyTotp(row.totp_secret, code);
        if (!valid) return json({ error: 'Código inválido' }, 401);

        if (user.totp_verified === 0) {
          await env.DB.prepare('UPDATE users SET totp_verified = 1 WHERE id = ?').bind(user.id).run();
        }
        await env.DB.prepare("UPDATE users SET ultimo_login = datetime('now') WHERE id = ?").bind(user.id).run();

        const auth = request.headers.get('Authorization') || '';
        const tempToken = auth.replace(/^Bearer\s+/i, '').trim();
        await deleteSession(env.DB, tempToken);

        const { token, expires_at } = await createSession(env.DB, user.id, 'full');

        return json({
          ok: true,
          session_token: token,
          expires_at,
          user: { email: user.email, nombre: user.nombre, rol: user.rol }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/auth/logout ───────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      try {
        const auth = request.headers.get('Authorization') || '';
        const token = auth.replace(/^Bearer\s+/i, '').trim();
        if (token) await deleteSession(env.DB, token);
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── GET /api/auth/me ────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/auth/me') {
      return json({
        ok: true,
        user: {
          email: authUser.email,
          nombre: authUser.nombre,
          rol: authUser.rol
        }
      });
    }

    // ══════════════════════════════════════════════════════
    // VEHÍCULOS (gestión web de grupos de Telegram)
    // ══════════════════════════════════════════════════════

    // ── GET /api/vehiculos ──────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/api/vehiculos') {
      try {
        const result = await env.DB.prepare(
          'SELECT placa, nombre, tipo, activo, telegram_chat_id FROM vehiculos ORDER BY placa ASC'
        ).all();
        return json({ ok: true, vehiculos: result.results || [] });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── PUT /api/vehiculos/:placa ───────────────────────────
    // Actualiza el telegram_chat_id de un vehículo (body { telegram_chat_id })
    if (request.method === 'PUT' && url.pathname.startsWith('/api/vehiculos/')) {
      try {
        const placa = decodeURIComponent(url.pathname.replace('/api/vehiculos/', '')).trim();
        if (!placa) return json({ error: 'Placa requerida' }, 400);

        const body = await request.json();
        const chatId = (body.telegram_chat_id === '' || body.telegram_chat_id === undefined)
          ? null : body.telegram_chat_id;

        const row = await env.DB.prepare('SELECT placa FROM vehiculos WHERE placa = ?').bind(placa).first();
        if (!row) return json({ error: 'Vehículo no encontrado' }, 404);

        await env.DB.prepare('UPDATE vehiculos SET telegram_chat_id = ? WHERE placa = ?')
          .bind(chatId, placa).run();
        return json({ ok: true, placa, telegram_chat_id: chatId });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ══════════════════════════════════════════════════════
    // TELEGRAM BOT
    // ══════════════════════════════════════════════════════

    // POST /api/telegram/webhook — Telegram envía updates aquí
    if (request.method === 'POST' && url.pathname === '/api/telegram/webhook') {
      try {
        const expected = env.TELEGRAM_WEBHOOK_SECRET;
        const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
        if (expected && got !== expected) {
          return json({ error: 'Invalid secret' }, 403);
        }

        const update = await request.json();
        // Responder rápido a Telegram (procesar en background)
        ctx.waitUntil(handleTelegramUpdate(update, env).catch(err => console.error('TG err:', err)));
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /api/telegram/setup — configura el webhook (admin only)
    if (request.method === 'POST' && url.pathname === '/api/telegram/setup') {
      try {
        const adminToken = request.headers.get('x-admin-token');
        if (!env.ADMIN_SETUP_TOKEN || adminToken !== env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Forbidden' }, 403);
        }
        if (!env.TELEGRAM_BOT_TOKEN) {
          return json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 400);
        }
        const webhookUrl = `https://${url.host}/api/telegram/webhook`;
        const secret = env.TELEGRAM_WEBHOOK_SECRET || crypto.randomUUID();
        const result = await setupWebhook(env, webhookUrl, secret);
        return json({
          ok: result.ok,
          webhook_url: webhookUrl,
          secret_to_save: env.TELEGRAM_WEBHOOK_SECRET ? '(already set)' : secret,
          telegram_response: result
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /api/telegram/health — health check público (lectura)
    if (request.method === 'GET' && url.pathname === '/api/telegram/health') {
      try {
        const health = await checkWebhookHealth(env);
        return json(health, health.healthy ? 200 : 503);
      } catch (err) {
        return json({ healthy: false, reason: 'exception', detail: err.message }, 500);
      }
    }

    // POST /api/telegram/heal — fuerza re-registro del webhook (admin only)
    if (request.method === 'POST' && url.pathname === '/api/telegram/heal') {
      try {
        const adminToken = request.headers.get('x-admin-token');
        if (!env.ADMIN_SETUP_TOKEN || adminToken !== env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Forbidden' }, 403);
        }
        const result = await healWebhook(env);
        const after = await checkWebhookHealth(env);
        return json({ heal: result, status_after: after });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /api/telegram/info — estado del bot (admin only)
    if (request.method === 'GET' && url.pathname === '/api/telegram/info') {
      try {
        const adminToken = request.headers.get('x-admin-token');
        if (!env.ADMIN_SETUP_TOKEN || adminToken !== env.ADMIN_SETUP_TOKEN) {
          return json({ error: 'Forbidden' }, 403);
        }
        if (!env.TELEGRAM_BOT_TOKEN) {
          return json({ error: 'TELEGRAM_BOT_TOKEN not configured' }, 400);
        }
        const me = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`).then(r => r.json());
        const wh = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getWebhookInfo`).then(r => r.json());
        return json({
          bot: me.result,
          webhook: wh.result,
          authorized_chats: env.TELEGRAM_AUTHORIZED_CHATS ? env.TELEGRAM_AUTHORIZED_CHATS.split(',').length : 0
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ════════════════════════════════════════════════════════════════════
    // PAGO MASIVO FINANDINA
    // ════════════════════════════════════════════════════════════════════

    // GET /api/pago-masivo/bancos — lista de bancos disponibles
    if (request.method === 'GET' && url.pathname === '/api/pago-masivo/bancos') {
      return json({ bancos: Object.keys(BANCO_A_FINANDINA), oficial: BANCO_A_FINANDINA });
    }

    // POST /api/extraer-certificado-bancario — OCR de certificación bancaria
    if (request.method === 'POST' && url.pathname === '/api/extraer-certificado-bancario') {
      try {
        if (!env.GEMINI_API_KEY) {
          return json({ error: 'GEMINI_API_KEY no configurada en el Worker' }, 500);
        }

        const form = await request.formData();
        const file = form.get('file');
        if (!file) return json({ error: 'No file' }, 400);

        const mimeType = file.type || 'application/pdf';
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        const b64 = btoa(binary);

        const extraido = await extraerCertificadoBancario(b64, mimeType, env.GEMINI_API_KEY);

        const split = splitTitular(extraido.titular);

        return json({
          ok: true,
          extraido,
          form_prefill: {
            banco_finandina: extraido.banco_finandina,
            tipo_cuenta: extraido.tipo_cuenta_cocicp,
            numero_cuenta: extraido.numero_cuenta,
            numero_documento_titular: extraido.cedula_nit,
            nombre_titular: split.nombre,
            apellido_titular: split.apellido,
            razon_social_titular: extraido.titular,
          },
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /api/proveedores — lista todos con estado de info bancaria
    if (request.method === 'GET' && url.pathname === '/api/proveedores') {
      try {
        const result = await env.DB.prepare(`
          SELECT p.*,
                 (SELECT COUNT(*) FROM gastos g WHERE g.proveedor_nit = p.nit) AS gastos_total,
                 (SELECT COUNT(*) FROM gastos g WHERE g.proveedor_nit = p.nit
                   AND (g.pagado_via IS NULL OR g.pagado_via = '')) AS gastos_sin_pagar,
                 (SELECT COALESCE(SUM(g.total),0) FROM gastos g WHERE g.proveedor_nit = p.nit
                   AND (g.pagado_via IS NULL OR g.pagado_via = '')) AS total_sin_pagar
          FROM proveedores p
          ORDER BY gastos_sin_pagar DESC, gastos_total DESC
        `).all();

        const rows = result.results || [];
        const conInfo = rows.filter(r => r.banco_finandina && r.numero_cuenta && r.numero_documento_titular);
        const sinInfo = rows.filter(r => !(r.banco_finandina && r.numero_cuenta && r.numero_documento_titular));

        return json({
          ok: true,
          total: rows.length,
          con_info: conInfo.length,
          sin_info: sinInfo.length,
          proveedores: rows,
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /api/proveedores — crear nuevo proveedor (con info opcional bancaria)
    if (request.method === 'POST' && url.pathname === '/api/proveedores') {
      try {
        const b = await request.json();
        if (!b.nombre && !b.nombre_corto) return json({ error: 'Nombre requerido' }, 400);

        if (b.nit) {
          const exists = await env.DB.prepare('SELECT id FROM proveedores WHERE nit = ?').bind(b.nit).first();
          if (exists) return json({ error: `Ya existe un proveedor con NIT ${b.nit}`, id: exists.id }, 409);
        }

        const result = await env.DB.prepare(`
          INSERT INTO proveedores (
            nit, nombre, nombre_corto, categoria_default,
            banco_finandina, tipo_cuenta, numero_cuenta,
            tipo_documento_titular, numero_documento_titular,
            nombre_titular, apellido_titular, razon_social_titular,
            email_notificacion
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          b.nit || null,
          b.nombre || b.nombre_corto,
          b.nombre_corto || b.nombre,
          b.categoria_default || null,
          b.banco_finandina || null,
          b.tipo_cuenta || null,
          b.numero_cuenta || null,
          b.tipo_documento_titular || null,
          b.numero_documento_titular || null,
          b.nombre_titular || null,
          b.apellido_titular || null,
          b.razon_social_titular || null,
          b.email_notificacion || null
        ).run();

        return json({ ok: true, id: result.meta?.last_row_id });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /api/pago-masivo/finandina-directo — genera TXT desde proveedores + montos custom
    if (request.method === 'POST' && url.pathname === '/api/pago-masivo/finandina-directo') {
      try {
        const body = await request.json();
        const { pagos, fechaPago, cuentaOrigen, tipoOrigen } = body;

        if (!Array.isArray(pagos) || pagos.length === 0) {
          return json({ error: 'Sin pagos especificados' }, 400);
        }
        if (!fechaPago || !cuentaOrigen) {
          return json({ error: 'fechaPago y cuentaOrigen requeridos' }, 400);
        }

        const last = await env.DB.prepare('SELECT MAX(identificacion) as max FROM dispersiones').first();
        const identificacionArchivo = (last?.max || 0) + 1;

        const beneficiarios = [];
        const errores = [];
        for (const p of pagos) {
          const valor = Math.round(Math.abs(parseFloat(p.valor) || 0));
          if (valor <= 0) {
            errores.push(`Proveedor ${p.proveedor_id}: valor inválido (${p.valor})`);
            continue;
          }
          const row = await env.DB.prepare('SELECT * FROM proveedores WHERE id = ?').bind(p.proveedor_id).first();
          if (!row) {
            errores.push(`Proveedor ID ${p.proveedor_id}: no encontrado`);
            continue;
          }
          if (!row.banco_finandina || !row.tipo_cuenta || !row.numero_cuenta) {
            errores.push(`${row.nombre_corto || row.nombre}: falta info bancaria`);
            continue;
          }
          const tipoDoc = row.tipo_documento_titular || 'CC';
          const isPJ = tipoDoc === 'NIT';
          beneficiarios.push({
            tipoIdentificacion: tipoDoc,
            identificacion: (row.numero_documento_titular || '').replace(/\D/g, ''),
            ...(isPJ
              ? { razonSocial: row.razon_social_titular || row.nombre_corto || row.nombre }
              : {
                  nombre: row.nombre_titular || (row.nombre_corto || row.nombre).split(' ')[0],
                  apellido: row.apellido_titular || (row.nombre_corto || row.nombre).split(' ').slice(1).join(' ') || 'PROVEEDOR',
                }),
            cuentaDestino: String(row.numero_cuenta).replace(/\D/g, ''),
            tipoCuentaDestino: row.tipo_cuenta,
            banco: row.banco_finandina,
            valor,
            referencia1: (p.referencia1 || `PAGO-${row.id}`).slice(0, 30),
            referencia2: (p.referencia2 || fechaPago.replace(/-/g, '')).slice(0, 30),
          });
        }

        if (beneficiarios.length === 0) {
          return json({ error: 'Ningún pago válido', errores }, 400);
        }

        const cabecera = {
          fechaPago: new Date(fechaPago + 'T12:00:00Z'),
          identificacionArchivo,
          tipoOrigen: tipoOrigen || 'ahorros',
          cuentaOrigen: String(cuentaOrigen).replace(/\D/g, ''),
        };
        const { content, resumen } = generarArchivoDispersion(cabecera, beneficiarios);
        const filename = sugerirNombreArchivo(resumen);

        await env.DB.prepare(`
          INSERT INTO dispersiones
            (identificacion, fecha_pago, cuenta_origen, tipo_origen, total_registros, total_valor, archivo_nombre, gastos_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          identificacionArchivo, fechaPago, cabecera.cuentaOrigen, cabecera.tipoOrigen,
          resumen.totalRegistros, resumen.totalValor, filename,
          'DIRECTO:' + pagos.map(p => p.proveedor_id).join(',')
        ).run();

        const bytes = contentToLatin1Bytes(content);
        return new Response(bytes, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain; charset=iso-8859-1',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Resumen-Registros': String(resumen.totalRegistros),
            'X-Resumen-Total': String(resumen.totalValor),
            'X-Archivo-Nombre': filename,
            'X-Errores': errores.length > 0 ? errores.join(' | ').slice(0, 500) : '',
          },
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // DELETE /api/proveedores/:id — borra un proveedor del catálogo
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/proveedores/') &&
        !url.pathname.endsWith('/banco')) {
      try {
        const idStr = url.pathname.replace('/api/proveedores/', '');
        const id = parseInt(idStr);
        if (!id) return json({ error: 'ID inválido' }, 400);

        const row = await env.DB.prepare('SELECT nombre_corto, nombre FROM proveedores WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Proveedor no encontrado' }, 404);

        await env.DB.prepare('DELETE FROM proveedores WHERE id = ?').bind(id).run();
        return json({ ok: true, borrado: row.nombre_corto || row.nombre });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // PUT /api/proveedores/:id/banco — actualiza info bancaria del proveedor
    if (request.method === 'PUT' && url.pathname.startsWith('/api/proveedores/') && url.pathname.endsWith('/banco')) {
      try {
        const idStr = url.pathname.replace('/api/proveedores/', '').replace('/banco', '');
        const id = parseInt(idStr);
        if (!id) return json({ error: 'ID inválido' }, 400);

        const body = await request.json();
        await env.DB.prepare(`
          UPDATE proveedores SET
            banco_finandina = ?,
            tipo_cuenta = ?,
            numero_cuenta = ?,
            tipo_documento_titular = ?,
            numero_documento_titular = ?,
            nombre_titular = ?,
            apellido_titular = ?,
            razon_social_titular = ?,
            email_notificacion = ?
          WHERE id = ?
        `).bind(
          body.banco_finandina || null,
          body.tipo_cuenta || null,
          body.numero_cuenta || null,
          body.tipo_documento_titular || null,
          body.numero_documento_titular || null,
          body.nombre_titular || null,
          body.apellido_titular || null,
          body.razon_social_titular || null,
          body.email_notificacion || null,
          id
        ).run();
        return json({ ok: true });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // GET /api/pago-masivo/preview — verifica qué gastos están listos vs faltan info
    // ?ids=1,2,3
    if (request.method === 'GET' && url.pathname === '/api/pago-masivo/preview') {
      try {
        const ids = (url.searchParams.get('ids') || '').split(',').map(s => parseInt(s.trim())).filter(Boolean);
        if (ids.length === 0) return json({ error: 'Sin IDs' }, 400);

        const placeholders = ids.map(() => '?').join(',');
        const result = await env.DB.prepare(`
          SELECT g.id, g.numero, g.fecha, g.proveedor_nit, g.proveedor_nombre,
                 g.total, g.concepto, g.numero_documento, g.pagado_via, g.vehiculo,
                 p.id as prov_id,
                 p.banco_finandina, p.tipo_cuenta, p.numero_cuenta,
                 p.tipo_documento_titular, p.numero_documento_titular,
                 p.nombre_titular, p.apellido_titular, p.razon_social_titular
          FROM gastos g
          LEFT JOIN proveedores p ON p.nit = g.proveedor_nit
          WHERE g.id IN (${placeholders})
        `).bind(...ids).all();

        const listos = [];
        const faltan = [];
        const yaPagados = [];

        for (const r of (result.results || [])) {
          if (r.pagado_via === 'finandina') {
            yaPagados.push(r);
            continue;
          }
          const ok = r.banco_finandina && r.tipo_cuenta && r.numero_cuenta &&
                     r.tipo_documento_titular && r.numero_documento_titular &&
                     ((r.tipo_documento_titular === 'NIT' && r.razon_social_titular) ||
                      (r.tipo_documento_titular !== 'NIT' && r.nombre_titular && r.apellido_titular));
          if (ok) listos.push(r);
          else faltan.push(r);
        }

        return json({
          ok: true,
          listos,
          faltan,
          yaPagados,
          total_listos: listos.reduce((s, r) => s + (r.total || 0), 0),
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // POST /api/pago-masivo/finandina — genera el archivo TXT
    if (request.method === 'POST' && url.pathname === '/api/pago-masivo/finandina') {
      try {
        const body = await request.json();
        const { gastoIds, fechaPago, cuentaOrigen, tipoOrigen, marcarComoPagado, overridesValor } = body;

        if (!Array.isArray(gastoIds) || gastoIds.length === 0) {
          return json({ error: 'Sin gastos seleccionados' }, 400);
        }
        if (!fechaPago || !cuentaOrigen) {
          return json({ error: 'fechaPago y cuentaOrigen son requeridos' }, 400);
        }

        const last = await env.DB.prepare('SELECT MAX(identificacion) as max FROM dispersiones').first();
        const identificacionArchivo = (last?.max || 0) + 1;

        const placeholders = gastoIds.map(() => '?').join(',');
        const result = await env.DB.prepare(`
          SELECT g.id, g.total, g.numero_documento, g.proveedor_nombre, g.fecha,
                 p.banco_finandina, p.tipo_cuenta, p.numero_cuenta,
                 p.tipo_documento_titular, p.numero_documento_titular,
                 p.nombre_titular, p.apellido_titular, p.razon_social_titular
          FROM gastos g
          LEFT JOIN proveedores p ON p.nit = g.proveedor_nit
          WHERE g.id IN (${placeholders}) AND (g.pagado_via IS NULL OR g.pagado_via = '')
        `).bind(...gastoIds).all();

        const rows = result.results || [];
        if (rows.length === 0) {
          return json({ error: 'Ningún gasto seleccionable (¿ya pagados?)' }, 400);
        }

        const errores = [];
        const beneficiarios = [];
        for (const r of rows) {
          if (!r.banco_finandina || !r.tipo_cuenta || !r.numero_cuenta) {
            errores.push(`Gasto #${r.id} (${r.proveedor_nombre}): falta info bancaria del proveedor`);
            continue;
          }
          const tipoDoc = r.tipo_documento_titular || 'CC';
          const isPJ = tipoDoc === 'NIT';

          beneficiarios.push({
            tipoIdentificacion: tipoDoc,
            identificacion: (r.numero_documento_titular || '').replace(/\D/g, ''),
            ...(isPJ
              ? { razonSocial: r.razon_social_titular || r.proveedor_nombre }
              : {
                  nombre: r.nombre_titular || r.proveedor_nombre.split(' ')[0],
                  apellido: r.apellido_titular || r.proveedor_nombre.split(' ').slice(1).join(' ') || 'PROVEEDOR',
                }),
            cuentaDestino: String(r.numero_cuenta).replace(/\D/g, ''),
            tipoCuentaDestino: r.tipo_cuenta,
            banco: r.banco_finandina,
            valor: (overridesValor && overridesValor[r.id])
                     ? Math.round(Math.abs(overridesValor[r.id]))
                     : Math.round(Math.abs(r.total)),
            referencia1: (r.numero_documento || `GASTO${r.id}`).slice(0, 30),
            referencia2: r.fecha?.replace(/-/g, '') || '',
          });
        }

        if (errores.length > 0 && beneficiarios.length === 0) {
          return json({ error: 'Todos los gastos tienen info incompleta', errores }, 400);
        }

        const cabecera = {
          fechaPago: new Date(fechaPago + 'T12:00:00Z'),
          identificacionArchivo,
          tipoOrigen: tipoOrigen || 'ahorros',
          cuentaOrigen: String(cuentaOrigen).replace(/\D/g, ''),
        };
        const { content, resumen } = generarArchivoDispersion(cabecera, beneficiarios);
        const filename = sugerirNombreArchivo(resumen);

        const idsStr = gastoIds.join(',');
        await env.DB.prepare(`
          INSERT INTO dispersiones
            (identificacion, fecha_pago, cuenta_origen, tipo_origen, total_registros, total_valor, archivo_nombre, gastos_ids)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          identificacionArchivo,
          fechaPago,
          cabecera.cuentaOrigen,
          cabecera.tipoOrigen,
          resumen.totalRegistros,
          resumen.totalValor,
          filename,
          idsStr
        ).run();

        if (marcarComoPagado) {
          const exitosos = gastoIds.filter((id, i) => beneficiarios.some(b => b.referencia1.includes(`GASTO${id}`) || rows[i]?.id === id));
          for (const gid of exitosos) {
            await env.DB.prepare(
              `UPDATE gastos SET pagado_via = 'finandina', fecha_pago_masivo = ?, archivo_dispersion = ? WHERE id = ?`
            ).bind(fechaPago, filename, gid).run();
          }
        }

        const bytes = contentToLatin1Bytes(content);
        return new Response(bytes, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': 'text/plain; charset=iso-8859-1',
            'Content-Disposition': `attachment; filename="${filename}"`,
            'X-Resumen-Registros': String(resumen.totalRegistros),
            'X-Resumen-Total': String(resumen.totalValor),
            'X-Archivo-Nombre': filename,
            'X-Errores': errores.length > 0 ? errores.join(' | ').slice(0, 500) : '',
          },
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }


    return json({ error: 'Not found' }, 404);
  },

  // ═══════════════════════════════════════════════════════════
  // CRON: Telegram self-heal + alertas diarias por email (Resend)
  // ═══════════════════════════════════════════════════════════
  async scheduled(event, env, ctx) {
    const now = new Date();
    const dia = now.getUTCDate();
    const mes = now.getUTCMonth() + 1;
    const anio = now.getUTCFullYear();
    const mesStr = `${anio}-${String(mes).padStart(2, '0')}`;

    // ── 0. Telegram self-healing (siempre primero, no debe fallar el resto) ──
    let telegramAlert = null;
    try {
      const health = await checkWebhookHealth(env);
      if (!health.healthy) {
        console.log('[CRON] Telegram webhook unhealthy:', health.reason);
        const heal = await healWebhook(env);
        const after = await checkWebhookHealth(env);
        telegramAlert = {
          had_issue: true,
          reason: health.reason,
          detail: health.last_error_message || health.detail || null,
          heal_attempted: heal.ok,
          recovered: after.healthy
        };
        console.log('[CRON] Heal result:', telegramAlert);
      } else {
        console.log('[CRON] Telegram webhook healthy');
      }
    } catch (err) {
      console.error('[CRON] Telegram health check failed:', err.message);
      telegramAlert = { had_issue: true, reason: 'check_threw', detail: err.message };
    }

    // 1. Obtener obligaciones pendientes
    let vencidas = [];
    let proximas = [];
    let pagadas = [];
    try {
      const obligs = await env.DB.prepare('SELECT * FROM obligaciones WHERE activo = 1').all();
      const gastosDelMes = await env.DB.prepare(
        "SELECT proveedor_nit, proveedor_nombre, total, fecha FROM gastos WHERE strftime('%Y-%m', fecha) = ?"
      ).bind(mesStr).all();

      const gastosNits = new Set((gastosDelMes.results || []).map(g => (g.proveedor_nit || '').replace(/\D/g, '')));
      const gastosNombres = (gastosDelMes.results || []).map(g => (g.proveedor_nombre || '').toLowerCase());

      for (const ob of (obligs.results || [])) {
        if (ob.frecuencia === 'anual') continue; // solo mensuales por ahora

        const nitBase = (ob.proveedor_nit || '').replace(/\D/g, '');
        const nombreLower = (ob.proveedor_nombre || ob.nombre || '').toLowerCase();
        const pagado = (nitBase && gastosNits.has(nitBase)) ||
          gastosNombres.some(n => n.includes(nombreLower) || nombreLower.includes(n));

        if (pagado) {
          pagadas.push(ob);
        } else if (ob.dia_limite && dia > ob.dia_limite) {
          vencidas.push(ob);
        } else if (ob.dia_limite && (ob.dia_limite - dia) <= 3) {
          proximas.push(ob);
        }
      }
    } catch (err) {
      console.error('[CRON] obligaciones check failed:', err.message);
    }

    // 2. Gastos en revisión
    let enRevision = 0;
    try {
      const revision = await env.DB.prepare(
        "SELECT COUNT(*) as cnt FROM gastos WHERE estado = 'revision'"
      ).first();
      enRevision = revision?.cnt || 0;
    } catch { /* ignore */ }

    // 3. Solo enviar si hay algo que reportar (incluye issues de Telegram)
    if (vencidas.length === 0 && proximas.length === 0 && enRevision === 0 && !telegramAlert?.had_issue) return;

    // 4. Construir email HTML
    const fmtCOP = v => v ? new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(v) : '';
    const meses = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];

    let html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0d0f0e;color:#e8ede8;padding:24px;border-radius:12px;">
      <div style="border-bottom:1px solid #222724;padding-bottom:16px;margin-bottom:16px;">
        <h1 style="font-size:20px;font-weight:300;color:#a0d0f0;margin:0;">🚛 Flota <span style="color:#6b7a6b;font-style:italic">alertas</span></h1>
        <p style="color:#6b7a6b;font-size:12px;margin:4px 0 0;">${dia} ${meses[mes-1]} ${anio}</p>
      </div>`;

    if (vencidas.length > 0) {
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:#f0b0a0;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">🔴 Vencidas (${vencidas.length})</h2>`;
      for (const ob of vencidas) {
        html += `<div style="background:#1a1111;border-left:3px solid #f0b0a0;padding:10px 14px;margin-bottom:6px;border-radius:0 6px 6px 0;">
          <strong style="color:#e8ede8;">${ob.nombre}</strong>
          <span style="color:#6b7a6b;font-size:11px;"> · ${ob.tipo === 'empresa' ? 'Flota' : 'Personal'} · Día ${ob.dia_limite}</span>
          ${ob.valor_estimado ? `<span style="float:right;color:#f0b0a0;font-weight:500;">${fmtCOP(ob.valor_estimado)}</span>` : ''}
        </div>`;
      }
      html += '</div>';
    }

    if (proximas.length > 0) {
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:#f0e0a0;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">🟡 Próximas a vencer (${proximas.length})</h2>`;
      for (const ob of proximas) {
        const diasRestantes = ob.dia_limite - dia;
        html += `<div style="background:#1a1a11;border-left:3px solid #f0e0a0;padding:10px 14px;margin-bottom:6px;border-radius:0 6px 6px 0;">
          <strong style="color:#e8ede8;">${ob.nombre}</strong>
          <span style="color:#6b7a6b;font-size:11px;"> · ${diasRestantes === 0 ? 'HOY' : diasRestantes + ' día(s)'} · Día ${ob.dia_limite}</span>
          ${ob.valor_estimado ? `<span style="float:right;color:#f0e0a0;font-weight:500;">${fmtCOP(ob.valor_estimado)}</span>` : ''}
        </div>`;
      }
      html += '</div>';
    }

    if (enRevision > 0) {
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:#a0d0f0;text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">📋 Gastos en revisión</h2>
        <div style="background:#111a1a;border-left:3px solid #a0d0f0;padding:10px 14px;border-radius:0 6px 6px 0;">
          ${enRevision} gasto(s) pendientes de revisión
        </div>
      </div>`;
    }

    // ── Bloque alerta Telegram (solo si hubo issue) ──
    if (telegramAlert?.had_issue) {
      const statusColor = telegramAlert.recovered ? '#f0e0a0' : '#f0b0a0';
      const statusIcon = telegramAlert.recovered ? '🟡' : '🔴';
      const statusText = telegramAlert.recovered
        ? 'Webhook recuperado automáticamente'
        : 'Webhook NO se pudo recuperar — revisa manualmente';
      html += `<div style="margin-bottom:16px;">
        <h2 style="font-size:13px;color:${statusColor};text-transform:uppercase;letter-spacing:0.05em;margin:0 0 8px;">${statusIcon} Telegram Bot</h2>
        <div style="background:#1a1a11;border-left:3px solid ${statusColor};padding:10px 14px;border-radius:0 6px 6px 0;">
          <strong style="color:#e8ede8;">${statusText}</strong>
          <div style="font-size:11px;color:#6b7a6b;margin-top:4px;">Razón: ${telegramAlert.reason}${telegramAlert.detail ? ' — ' + telegramAlert.detail : ''}</div>
        </div>
      </div>`;
    }

    html += `<div style="text-align:center;margin-top:20px;">
        <a href="${env.FRONTEND_URL || 'https://flota.davidduque.com'}" style="display:inline-block;background:#a0d0f0;color:#0d1a0d;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:500;font-size:13px;">Abrir Flota Gastos</a>
      </div>
      <div style="text-align:center;margin-top:12px;color:#6b7a6b;font-size:10px;">
        ${pagadas.length} obligaciones pagadas este mes ✓
      </div>
    </div>`;

    // 5. Enviar por Resend
    const resendKey = env.RESEND_API_KEY;
    if (!resendKey) return;

    let subject;
    if (telegramAlert?.had_issue && !telegramAlert.recovered) {
      subject = `🔴 Telegram bot caído + alertas — ${dia} ${meses[mes-1]}`;
    } else if (vencidas.length > 0) {
      subject = `🔴 ${vencidas.length} obligación(es) vencida(s) — ${dia} ${meses[mes-1]}`;
    } else if (proximas.length > 0) {
      subject = `🟡 ${proximas.length} pago(s) próximo(s) — ${dia} ${meses[mes-1]}`;
    } else if (telegramAlert?.had_issue) {
      subject = `🟡 Telegram bot reparado — ${dia} ${meses[mes-1]}`;
    } else {
      subject = `📋 ${enRevision} gasto(s) en revisión — ${dia} ${meses[mes-1]}`;
    }

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM || 'Flota Alertas <alertas@davidduque.com>',
        to: [env.ALERT_EMAIL_TO || 'david@davidduque.com'],
        subject,
        html
      })
    });
  }
};
