// ============================================================
// Telegram Bot FLOTA — captura de gastos por vehículo
// 1 bot en 3 grupos. Cada grupo (chat_id) mapea a un vehículo
// en la tabla vehiculos.telegram_chat_id. Auto-confirmado.
// ============================================================

import { runOcrAgent } from './agent-router.js';
import { runManifiestoAgent } from './agent-manifiesto.js';

const TG_API = 'https://api.telegram.org';
const VEHICULOS_FLOTA = ['STT115', 'STT121', 'UPO707'];

// El webhook responde 200 enseguida y el trabajo corre en ctx.waitUntil, con un techo de ~30 s de pared
// después de responder (pasado eso el proceso muere SIN dejar rastro). 26 s deja margen para registrar el pendiente y avisar.
const PRESUPUESTO_MS = 26000;
const MAX_INTENTOS = 6;   // intentos en total (el original + los reintentos) antes de abandonar un pendiente
const RECLAMO_MIN = 5;    // minutos que vale el reclamo de una fila 'procesando' (una foto tarda ≤ ~30 s): pasados, la ejecución que la tomó se da por muerta
// Los pendientes se reintentan en el cron diario (wrangler.toml: 0 12 * * * UTC = 7 a. m. en Colombia) o a mano desde el dashboard:
// el aviso al grupo dice cuándo, no promete un "se reintenta sola" sin hora
const CUANDO_REINTENTA = 'a las 7 a. m.';
const SIN_FORMATO = { parse_mode: undefined };   // JSON.stringify descarta undefined → mensaje sin Markdown (textos con "_" de códigos de error)

async function tgRequest(token, method, body) {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

// Nunca lanza: si Telegram rechaza el mensaje o la red falla queda en el log (antes se perdía en silencio)
async function sendMessage(token, chatId, text, opts = {}) {
  const body = { chat_id: chatId, text, parse_mode: 'Markdown', ...opts };
  let r;
  try {
    r = await tgRequest(token, 'sendMessage', body);
    // Telegram rechaza el mensaje entero si no puede parsear el Markdown (p. ej. un "_" suelto en un código de error)
    // y el usuario nunca lo recibe: se reenvía UNA vez el mismo texto sin parse_mode
    if (r && r.ok === false && body.parse_mode && /parse entities|can't parse/i.test(String(r.description || ''))) {
      const { parse_mode, ...sinFormato } = body;
      r = await tgRequest(token, 'sendMessage', sinFormato);
    }
  } catch (err) {
    r = { ok: false, description: 'sendMessage_failed: ' + sinSecretos(err && err.message) };
  }
  if (r && r.ok === false) console.warn('[TG] sendMessage rechazado:', r.error_code || '', String(r.description || '').slice(0, 200));
  return r;
}
// El indicador "escribiendo" es cosmético: si falla no debe tumbar el procesamiento
async function sendChatAction(token, chatId, action = 'typing') {
  try { return await tgRequest(token, 'sendChatAction', { chat_id: chatId, action }); } catch { return null; }
}

function fmtCOP(n) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
}
function escapeMd(s) { return String(s || '').replace(/[_*`[\]]/g, '\\$&'); }

// Los mensajes de error de fetch pueden traer la URL (con el token del bot): se redactan antes de loguear o guardar
function sinSecretos(s) {
  return String(s || '').replace(/bot\d+:[\w-]+/g, 'bot***').replace(/sk-ant-[\w-]+|AIza[\w-]+/g, '***');
}
function motivoCorto(err) {
  return sinSecretos((err && err.message) || err).replace(/\s+/g, ' ').trim().slice(0, 80) || 'error desconocido';
}

// YYYY-MM-DD en America/Bogota (UTC-5 fijo, Colombia no tiene horario de verano) a partir de segundos unix
function fechaBogota(segundos) {
  const ms = Number.isFinite(segundos) ? segundos * 1000 : Date.now();
  return new Date(ms - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

function aBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// ── Resolver vehículo desde el chat_id del grupo ──────────
async function vehiculoDeChat(db, chatId) {
  if (!db || chatId == null) return null;
  try {
    const row = await db.prepare(
      'SELECT placa, nombre FROM vehiculos WHERE telegram_chat_id = ?'
    ).bind(String(chatId)).first();
    return row || null;
  } catch { return null; }
}

// ── Autorización: el chat es un grupo de vehículo, o admin ──
async function autorizar(db, env, chatId) {
  const veh = await vehiculoDeChat(db, chatId);
  if (veh) return { ok: true, vehiculo: veh.placa, vehiculoNombre: veh.nombre };
  // Admin chats (lista blanca para comandos / pruebas)
  const raw = env.TELEGRAM_AUTHORIZED_CHATS || '';
  const allowed = raw.split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.includes(String(chatId))) return { ok: true, vehiculo: null, vehiculoNombre: null, esAdmin: true };
  return { ok: false };
}

async function checkDuplicate(db, numeroDocumento, total, fecha, proveedorNit) {
  if (!db) return null;
  if (numeroDocumento) {
    const row = await db.prepare('SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ?').bind(numeroDocumento).first();
    if (row) return { registro: row };
  }
  if (total && fecha && proveedorNit) {
    const row = await db.prepare('SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND proveedor_nit = ?').bind(total, fecha, proveedorNit).first();
    if (row) return { registro: row };
  }
  return null;
}

// ── Notificación email (Resend) ───────────────────────────
async function notificarEmail(env, numero, vehiculo, preview) {
  if (!env.RESEND_API_KEY) return;
  const fmt = v => new Intl.NumberFormat('es-CO', { style:'currency', currency:'COP', maximumFractionDigits:0 }).format(v || 0);
  const html = `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto;background:#0d0e0f;color:#e8ebee;padding:20px;border-radius:10px;">
    <h2 style="font-size:16px;font-weight:300;color:#a0d0f0;margin:0 0 12px;">🚛 Gasto registrado por Telegram</h2>
    <div style="background:#141517;border:1px solid #222427;border-radius:8px;padding:14px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:8px;">
        <span style="background:#1a2a3a;color:#a0d0f0;padding:2px 8px;border-radius:4px;font-size:11px;">${vehiculo || 'SIN VEHÍCULO'}</span>
        <strong style="color:#b8f0a0;font-size:16px;">${fmt(preview.total)}</strong>
      </div>
      <div style="color:#e8ebee;font-size:13px;font-weight:500;">${preview.proveedor_nombre || '—'}</div>
      <div style="color:#6b7580;font-size:12px;margin-top:4px;">${preview.concepto || '—'}</div>
      <div style="color:#6b7580;font-size:11px;margin-top:6px;">${preview.fecha || '—'} · ${preview.categoria || '—'} · #${numero}</div>
    </div>
    <div style="text-align:center;margin-top:14px;">
      <a href="${env.FRONTEND_URL || 'https://flota.davidduque.com'}" style="display:inline-block;background:#a0d0f0;color:#0d1a0d;padding:8px 20px;border-radius:6px;text-decoration:none;font-size:12px;font-weight:500;">Ver dashboard</a>
    </div></div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.RESEND_API_KEY}` },
      body: JSON.stringify({
        from: env.ALERT_EMAIL_FROM || 'Flota Alertas <alertas@davidduque.com>',
        to: [env.ALERT_EMAIL_TO || 'david@davidduque.com'],
        subject: `🚛 ${vehiculo || 'Flota'} — ${fmt(preview.total)} — ${preview.proveedor_nombre || preview.concepto || 'Gasto'}`,
        html
      })
    });
  } catch {}
}

// ── Comandos ──────────────────────────────────────────────
async function handleCommand(env, chatId, text, fromName, auth) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const cmd = text.trim().split(' ')[0].toLowerCase().replace(/@\w+$/, '');
  const vehLabel = auth.vehiculoNombre ? ` (${auth.vehiculoNombre})` : '';

  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(token, chatId,
      `*Flota Gastos Bot* 🚛\n\n` +
      `Hola ${escapeMd(fromName)} 👋\n\n` +
      (auth.vehiculo
        ? `Este grupo está vinculado a *${escapeMd(auth.vehiculoNombre)}*.\n\nEnvía una *foto o PDF* de cualquier factura, peaje, recibo de combustible o gasto y lo registro automáticamente para este vehículo.\n\nTambién detecto *manifiestos electrónicos de carga* 🚚 y los registro como viajes/ingresos (flete, anticipo, saldo a cobrar).`
        : `Tu chat no está vinculado a un vehículo todavía.`) +
      `\n\n*Comandos:*\n/total — Total del mes${vehLabel}\n/ultimos — Últimos 5 gastos\n/id — Ver el chat_id de este grupo\n/help — Ayuda`
    );
    return;
  }

  if (cmd === '/id') {
    await sendMessage(token, chatId,
      `🆔 *chat_id de este grupo:*\n\`${chatId}\`\n\n` +
      (auth.vehiculo ? `Vinculado a: *${escapeMd(auth.vehiculoNombre)}*` : `_Sin vehículo. Configúralo en el dashboard → Vehículos → pega este chat_id._`)
    );
    return;
  }

  if (cmd === '/total') {
    const now = new Date();
    const desde = `${now.getUTCFullYear()}-${String(now.getUTCMonth()+1).padStart(2,'0')}-01`;
    let sql = 'SELECT COUNT(*) as cnt, COALESCE(SUM(total),0) as total FROM gastos WHERE fecha >= ?';
    const binds = [desde];
    if (auth.vehiculo) { sql += ' AND vehiculo = ?'; binds.push(auth.vehiculo); }
    const r = await env.DB.prepare(sql).bind(...binds).first();
    await sendMessage(token, chatId,
      `📊 *Mes actual${vehLabel}*\n\nRegistros: *${r?.cnt || 0}*\nTotal: *${fmtCOP(r?.total || 0)}*`);
    return;
  }

  if (cmd === '/ultimos') {
    let sql = 'SELECT numero, fecha, vehiculo, proveedor_nombre, total, categoria FROM gastos';
    const binds = [];
    if (auth.vehiculo) { sql += ' WHERE vehiculo = ?'; binds.push(auth.vehiculo); }
    sql += ' ORDER BY id DESC LIMIT 5';
    const rows = await env.DB.prepare(sql).bind(...binds).all();
    if (!rows.results?.length) { await sendMessage(token, chatId, 'No hay gastos registrados.'); return; }
    const lines = rows.results.map(g =>
      `• #${g.numero} ${g.fecha} — ${escapeMd(g.proveedor_nombre)} ${fmtCOP(g.total)}\n  _${escapeMd(g.vehiculo || '')} · ${escapeMd(g.categoria)}_`);
    await sendMessage(token, chatId, `📋 *Últimos 5${vehLabel}*\n\n${lines.join('\n\n')}`);
    return;
  }

  await sendMessage(token, chatId, 'Envíame una *foto* del gasto o usa /help');
}

// ── Pendientes: fotos que no se pudieron procesar ─────────
// El archivo queda en R2 y el registro aquí; reintentarPendientes() las reprocesa (cron diario o a mano desde el dashboard)
export async function asegurarTablaPendientes(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ocr_pendientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    creado_en TEXT DEFAULT (datetime('now')),
    actualizado_en TEXT,
    chat_id TEXT,
    vehiculo TEXT,
    usuario TEXT,
    media_group_id TEXT,
    fecha_mensaje TEXT,
    archivo_r2 TEXT UNIQUE,
    mime TEXT,
    tipo TEXT,
    motivo TEXT,
    intentos INTEGER DEFAULT 1,
    estado TEXT DEFAULT 'pendiente',
    resultado TEXT)`).run();
}

// p = { chatId, vehiculo, usuario, mediaGroupId, fechaMensaje, r2Key, mime, tipo ('documento' | 'manifiesto'), motivo }
// Si el archivo ya estaba registrado suma un intento y actualiza el motivo. Nunca lanza (no debe tapar el error original).
async function registrarPendiente(env, p) {
  try {
    await asegurarTablaPendientes(env);
    await env.DB.prepare(`
      INSERT INTO ocr_pendientes
        (chat_id, vehiculo, usuario, media_group_id, fecha_mensaje, archivo_r2, mime, tipo, motivo, actualizado_en)
      VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))
      ON CONFLICT(archivo_r2) DO UPDATE SET
        intentos = intentos + 1, motivo = excluded.motivo, actualizado_en = datetime('now')
    `).bind(
      p.chatId != null ? String(p.chatId) : null, p.vehiculo || null, p.usuario || null, p.mediaGroupId || null,
      p.fechaMensaje || null, p.r2Key, p.mime || null, p.tipo || 'documento', sinSecretos(p.motivo).slice(0, 300)
    ).run();
  } catch (err) {
    console.error('[TG] no pude registrar el pendiente', p.r2Key, sinSecretos(err && err.message));
  }
}

// Al abandonar un pendiente se avisa al grupo una vez (los reintentos intermedios no avisan, para no llenarlo de mensajes)
async function avisarAbandono(env, fila, motivo) {
  if (!env.TELEGRAM_BOT_TOKEN || !fila.chat_id || /^sin_placa/.test(String(motivo || ''))) return;
  await sendMessage(env.TELEGRAM_BOT_TOKEN, fila.chat_id,
    `No pude procesar una foto enviada antes (${String(motivo || '').slice(0, 80)}). Se intentó varias veces; revísela en el dashboard o envíela de nuevo.`, SIN_FORMATO);
}

// Reprocesa fotos pendientes (estado 'pendiente' con menos de MAX_INTENTOS), o la fila `id`: primero las de menos intentos
// (una que falla siempre no le quita el turno a las sanas) y luego en orden de id.
// Cada fila se RECLAMA antes de procesarla (estado 'procesando'): el cron, el botón del dashboard y /api/enviar-alerta pueden
// coincidir y sin reclamo dos ejecuciones harían el OCR y el registro de la misma foto (gasto/viaje duplicado y mensajes espurios).
// En serie y sin arrancar otra si el lote ya lleva 60 s: una ejecución no pasa de ~80 s en total.
export async function reintentarPendientes(env, { limite = 3, id = null } = {}) {
  const inicio = Date.now();
  const out = { procesados: 0, resueltos: 0, fallidos: 0, abandonados: 0, detalle: [] };
  await asegurarTablaPendientes(env);

  let filas;
  if (id != null) {
    const fila = await env.DB.prepare('SELECT * FROM ocr_pendientes WHERE id = ?').bind(id).first();
    filas = fila ? [fila] : [];
  } else {
    const tope = Math.min(Math.max(Math.floor(Number(limite)) || 3, 1), 10);
    // También las 'procesando' viejas: son de una ejecución que murió a mitad y nadie las va a terminar
    const r = await env.DB.prepare(
      `SELECT * FROM ocr_pendientes
        WHERE intentos < ? AND (estado = 'pendiente' OR (estado = 'procesando' AND actualizado_en <= datetime('now','-${RECLAMO_MIN} minutes')))
        ORDER BY intentos ASC, id ASC LIMIT ?`
    ).bind(MAX_INTENTOS, tope).all();
    filas = r.results || [];
  }

  for (const fila of filas) {
    if (Date.now() - inicio >= 60000) break;
    // Reprocesar una ya resuelta duplicaría el registro
    if (fila.estado === 'resuelto') { out.detalle.push({ id: fila.id, estado: 'resuelto', omitido: 'ya estaba resuelto' }); continue; }
    // Reclamo atómico: el UPDATE solo afecta la fila si sigue libre; si otra ejecución ya la tomó (o la resolvió) no se toca.
    // Por id también se reclama una 'abandonado' (reintento forzado por el administrador)
    const reclamo = await env.DB.prepare(
      `UPDATE ocr_pendientes SET estado = 'procesando', actualizado_en = datetime('now')
        WHERE id = ? AND (estado = 'pendiente'${id != null ? " OR estado = 'abandonado'" : ''}
              OR (estado = 'procesando' AND actualizado_en <= datetime('now','-${RECLAMO_MIN} minutes')))`
    ).bind(fila.id).run();
    if (!(reclamo && reclamo.meta && reclamo.meta.changes > 0)) {
      out.detalle.push({ id: fila.id, omitido: 'otra ejecución la está procesando o ya la resolvió' });
      continue;
    }
    out.procesados++;
    const det = { id: fila.id, archivo_r2: fila.archivo_r2 };

    let res = null;        // lo que devuelve procesarDocumento: { ok, resultado } | { pendiente, motivo }
    let sinArchivo = false;
    let lanzo = false;
    try {
      const obj = await env.BUCKET.get(fila.archivo_r2);
      if (!obj) {
        sinArchivo = true;
      } else {
        res = await procesarDocumento(env, {
          chatId: fila.chat_id,
          b64: aBase64(await obj.arrayBuffer()),
          mime: fila.mime || obj.httpMetadata?.contentType || 'image/jpeg',
          r2Key: fila.archivo_r2,
          usuario: fila.usuario,
          vehiculo: fila.vehiculo,
          mediaGroupId: fila.media_group_id,
          fechaMensaje: fila.fecha_mensaje,
          // Presupuesto nuevo para cada foto, recortado para que el lote entero no pase de ~80 s
          t0: Math.min(Date.now(), inicio + 80000 - PRESUPUESTO_MS),
          reintento: true,
          tipoConocido: fila.tipo   // un manifiesto ya clasificado no se vuelve a clasificar (ahorra una llamada y ~la mitad del tiempo)
        });
      }
    } catch (err) {
      lanzo = true;
      console.error('[TG] reintento falló', fila.archivo_r2, err && err.stack || err);
      await registrarPendiente(env, {
        chatId: fila.chat_id, vehiculo: fila.vehiculo, usuario: fila.usuario, mediaGroupId: fila.media_group_id,
        fechaMensaje: fila.fecha_mensaje, r2Key: fila.archivo_r2, mime: fila.mime,
        tipo: (err && err.tipoPendiente) || fila.tipo, motivo: motivoCorto(err)
      });
    }

    if (sinArchivo) {
      await env.DB.prepare(`UPDATE ocr_pendientes SET estado = 'abandonado', motivo = 'sin_archivo', actualizado_en = datetime('now') WHERE id = ?`)
        .bind(fila.id).run();
      out.abandonados++;
      det.estado = 'abandonado'; det.motivo = 'sin_archivo';
      await avisarAbandono(env, fila, 'la foto ya no está guardada');
    } else if (!lanzo && !(res && res.pendiente)) {
      const resultado = String((res && res.resultado) || 'ok').slice(0, 200);
      await env.DB.prepare(`UPDATE ocr_pendientes SET estado = 'resuelto', resultado = ?, actualizado_en = datetime('now') WHERE id = ?`)
        .bind(resultado, fila.id).run();
      out.resueltos++;
      det.estado = 'resuelto'; det.resultado = resultado;
    } else {
      // Falló otra vez: el intento ya quedó sumado por registrarPendiente; al llegar a MAX_INTENTOS se abandona,
      // si no la fila se suelta (de 'procesando' vuelve a 'pendiente')
      const act = await env.DB.prepare('SELECT intentos, motivo FROM ocr_pendientes WHERE id = ?').bind(fila.id).first();
      det.motivo = (act && act.motivo) || (res && res.motivo) || null;
      det.intentos = act ? act.intentos : null;
      const abandonar = !!act && act.intentos >= MAX_INTENTOS;
      await env.DB.prepare(`UPDATE ocr_pendientes SET estado = ?, actualizado_en = datetime('now') WHERE id = ?`)
        .bind(abandonar ? 'abandonado' : 'pendiente', fila.id).run();
      if (abandonar) {
        out.abandonados++;
        det.estado = 'abandonado';
        await avisarAbandono(env, fila, det.motivo);
      } else {
        out.fallidos++;
        det.estado = 'fallido';
      }
    }
    out.detalle.push(det);
  }
  return out;
}

// ── Procesar foto/documento ───────────────────────────────
// Descarga el archivo, lo guarda en R2 y lo entrega a procesarDocumento. Lo que se rompa después queda registrado
// como pendiente (con el archivo en R2) y avisado al grupo: nada se pierde en silencio.
async function handleMedia(env, chatId, fileId, fileName, mimeType, usuario, vehiculo, mediaGroupId, fechaMensaje) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const t0 = Date.now();
  await sendChatAction(token, chatId, 'typing');

  let b64, resolvedMime, r2Key;
  try {
    const fileInfo = await tgRequest(token, 'getFile', { file_id: fileId });
    if (!fileInfo.ok) { await sendMessage(token, chatId, '❌ No pude obtener el archivo.'); return; }
    const filePath = fileInfo.result.file_path;
    const fileSize = fileInfo.result.file_size || 0;
    if (fileSize > 20 * 1024 * 1024) { await sendMessage(token, chatId, '❌ Archivo > 20MB.'); return; }

    const fileRes = await fetch(`${TG_API}/file/bot${token}/${filePath}`);
    if (!fileRes.ok) { await sendMessage(token, chatId, '❌ Error descargando.'); return; }
    const buf = await fileRes.arrayBuffer();
    b64 = aBase64(buf);

    resolvedMime = mimeType;
    if (!resolvedMime || resolvedMime === 'application/octet-stream') {
      if (filePath.endsWith('.png')) resolvedMime = 'image/png';
      else if (filePath.endsWith('.pdf')) resolvedMime = 'application/pdf';
      else resolvedMime = 'image/jpeg';
    }

    const safeName = (fileName || filePath.split('/').pop() || 'telegram').replace(/[^\w.\-]/g, '_');
    r2Key = `soportes/${Date.now()}-tg-${safeName}`;
    // El put se espera ANTES de procesar: así "pendiente" siempre significa "archivo guardado en R2"
    await env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType: resolvedMime } });
  } catch (err) {
    console.error('[TG] no pude descargar/guardar la foto:', err && err.stack || err);
    await sendMessage(token, chatId, `No pude descargar o guardar esta foto (${motivoCorto(err)}). Envíela de nuevo, por favor.`, SIN_FORMATO);
    return;
  }

  try {
    await procesarDocumento(env, { chatId, b64, mime: resolvedMime, r2Key, usuario, vehiculo, mediaGroupId, fechaMensaje, t0 });
  } catch (err) {
    // Antes esto solo iba a console.error y el grupo nunca se enteraba
    console.error('[TG] error procesando', r2Key, err && err.stack || err);
    const motivo = motivoCorto(err);
    await registrarPendiente(env, {
      chatId, vehiculo, usuario, mediaGroupId, fechaMensaje, r2Key, mime: resolvedMime,
      tipo: (err && err.tipoPendiente) || 'documento', motivo
    });
    await sendMessage(token, chatId,
      `No pude procesar esta foto (${motivo}). Quedó guardada y se reintenta sola ${CUANDO_REINTENTA}; si no aparece en el dashboard avise.`, SIN_FORMATO);
  }
}

// Todo lo que pasa DESPUÉS de tener el archivo descargado y guardado en R2: OCR y registro como planilla,
// manifiesto (viaje) o gasto.
// doc = { chatId, b64, mime, r2Key, usuario, vehiculo, mediaGroupId, fechaMensaje, t0, reintento?, tipoConocido? }
// En un reintento (reintento: true) el auto-enlace de recibos↔viaje es SOLO por media_group_id: las ventanas de 3 minutos miden
// contra "ahora" (la hora del reintento), no contra la hora en que el conductor mandó la foto, y enlazarían documentos de días distintos.
// tipoConocido: 'manifiesto' → ya se sabe que lo es (pendiente de un manifiesto) y no se vuelve a clasificar.
// Devuelve { ok: true, resultado } o { pendiente: true, motivo } (este último ya quedó registrado en ocr_pendientes).
// Si algo se rompe lanza, con err.tipoPendiente: quien llama lo registra como pendiente.
export async function procesarDocumento(env, doc) {
  const { chatId, b64, mime, r2Key, usuario, vehiculo, mediaGroupId, fechaMensaje, reintento, tipoConocido } = doc;
  const token = env.TELEGRAM_BOT_TOKEN;
  const t0 = doc.t0 || Date.now();
  const deadline = t0 + PRESUPUESTO_MS;   // los agentes recortan cada llamada a lo que quede de presupuesto
  const fechaBase = fechaMensaje || fechaBogota();
  let tipo = 'documento';

  // No se pudo procesar pero NO se pierde: el archivo queda en R2, se registra el pendiente y se avisa al grupo
  // (los reintentos no vuelven a avisar)
  const dejarPendiente = async (tipoPend, motivo, aviso) => {
    await registrarPendiente(env, { chatId, vehiculo, usuario, mediaGroupId, fechaMensaje: fechaBase, r2Key, mime, tipo: tipoPend, motivo });
    if (!reintento) await sendMessage(token, chatId, aviso, SIN_FORMATO);
    return { pendiente: true, motivo };
  };

  try {
    if (!reintento) await sendChatAction(token, chatId, 'typing');

    // Con Gemini caído la clasificación cae a Sonnet y, si era un manifiesto, la extracción sería una 2.ª llamada a Claude EN SERIE
    // bajo el mismo presupuesto de 26 s: no cabe de forma fiable. Por eso, en cuanto la clasificación cae a Sonnet porque Gemini
    // falló, la extracción arranca EN PARALELO (directo a Claude: Gemini acaba de fallar con esta foto). Si el documento no resulta
    // ser un manifiesto ese resultado se descarta (cuesta una llamada de más, solo mientras Gemini está caído)
    const extraerManifiesto = (extra = {}) =>
      runManifiestoAgent(b64, mime, env.GEMINI_API_KEY, env.DB, { anthropicKey: env.ANTHROPIC_API_KEY, deadline, ...extra });
    let manAdelantado = null;
    const alCaerASonnet = () => {
      if (!env.ANTHROPIC_API_KEY || manAdelantado) return;
      manAdelantado = extraerManifiesto({ sinGemini: true });
      manAdelantado.catch(() => {});   // si nadie la espera (no era manifiesto) que no quede como rechazo sin capturar
    };

    // Un reintento de un manifiesto ya clasificado no gasta otra llamada de clasificación (ni su tiempo)
    const preview = tipoConocido === 'manifiesto'
      ? { es_manifiesto: true }
      : await runOcrAgent(b64, mime, env, env.DB, { deadline, alCaerASonnet });

    if (preview.error) {
      const detalle = preview._ocr_fallback_reason ? `${preview.error} (gemini: ${preview._ocr_fallback_reason})` : preview.error;
      return await dejarPendiente('documento', detalle,
        `❌ Error procesando: ${preview.error}\n\nLa foto quedó guardada y se reintenta sola ${CUANDO_REINTENTA}; si no aparece en el dashboard avise.`);
    }

    // ── Hoja de control / consolidado del conductor → NO es gasto (evita doble conteo) ──
    if (preview && preview.es_planilla === true) {
      try { await env.BUCKET.delete(r2Key); } catch {}
      await sendMessage(token, chatId,
        `📋 *Hoja de control de viaje* detectada — es el resumen del conductor, *no se cuenta como gasto*.\n\n` +
        `Los gastos se toman de sus recibos individuales y el ingreso del manifiesto.`);
      return { ok: true, resultado: 'planilla' };
    }

    // ── Manifiesto electrónico de carga → tabla viajes (ingreso) ──
    if (preview && preview.es_manifiesto === true) {
      tipo = 'manifiesto';
      const man = await (manAdelantado || extraerManifiesto());
      if (man.error) {
        return await dejarPendiente('manifiesto', man.error,
          `❌ Error procesando manifiesto: ${man.error}\n\nQuedó guardado y se reintenta solo ${CUANDO_REINTENTA}; si no aparece en el dashboard avise.`);
      }

      let vehManifiesto = vehiculo || man.vehiculo || null;
      // Reclasificación por placa: si el manifiesto muestra una placa válida distinta a la del grupo, gana la del manifiesto
      if (man.vehiculo && VEHICULOS_FLOTA.includes(man.vehiculo) && vehiculo && man.vehiculo !== vehiculo) {
        vehManifiesto = man.vehiculo;
      }

      // ── Anti-duplicado ──
      // Con número legible, duplicado = el MISMO número de manifiesto (dos manifiestos con número distinto en un mismo
      // álbum son dos viajes). Solo sin número legible se mira el álbum (otra página del mismo manifiesto)
      // o la coincidencia de vehículo + fecha + flete en los últimos 30 minutos.
      let viajeDup = null;
      try {
        if (man.numero_manifiesto) {
          viajeDup = await env.DB.prepare('SELECT id, numero FROM viajes WHERE numero_manifiesto = ? LIMIT 1').bind(man.numero_manifiesto).first();
          if (!viajeDup) {
            // El mismo número leído con otro formato ("MC-791199" / "791199" / "791 199"): se compara por los dígitos
            const dig = String(man.numero_manifiesto).replace(/\D/g, '');
            const cola = dig.slice(-3);   // candidatos por los últimos 3 dígitos (un espacio o guion puede partir los últimos 4); la comparación real es por todos los dígitos
            const cand = await env.DB.prepare('SELECT id, numero, numero_manifiesto FROM viajes WHERE numero_manifiesto LIKE ? LIMIT 100').bind(`%${cola}%`).all();
            viajeDup = ((cand && cand.results) || []).find(v => String(v.numero_manifiesto || '').replace(/\D/g, '') === dig) || null;
          }
        } else {
          if (mediaGroupId) {
            viajeDup = await env.DB.prepare('SELECT id, numero FROM viajes WHERE media_group_id = ? LIMIT 1').bind(mediaGroupId).first();
          }
          if (!viajeDup && vehManifiesto && man.fecha_viaje) {
            viajeDup = await env.DB.prepare(
              `SELECT id, numero FROM viajes
                 WHERE vehiculo = ? AND fecha_viaje = ? AND ABS(valor_flete - ?) < 1000
                   AND creado_en >= datetime('now','-30 minutes') LIMIT 1`
            ).bind(vehManifiesto, man.fecha_viaje, man.valor_flete || 0).first();
          }
        }
      } catch {}
      if (viajeDup) {
        // Es un duplicado (otra página/copia del mismo manifiesto). No crear viaje nuevo;
        // enlazar al existente los recibos del mismo álbum.
        if (mediaGroupId) {
          try { await env.DB.prepare(`UPDATE gastos SET viaje_id = ? WHERE media_group_id = ? AND viaje_id IS NULL`).bind(viajeDup.id, mediaGroupId).run(); } catch {}
        }
        // En un reintento el archivo puede ser el del propio viaje ya registrado (falló después del INSERT): no se borra
        if (!reintento) { try { await env.BUCKET.delete(r2Key); } catch {} }
        await sendMessage(token, chatId, `ℹ️ Este manifiesto ya está registrado como viaje #${viajeDup.numero} — no se duplicó.`);
        return { ok: true, resultado: `duplicado de viaje #${viajeDup.numero}` };
      }

      // viajes.vehiculo es NOT NULL: sin grupo de vehículo ni placa legible no se inserta
      if (!vehManifiesto) {
        return await dejarPendiente('manifiesto', 'sin_placa',
          `⚠️ No pude saber de qué vehículo es este manifiesto: no se lee la placa y este chat no está vinculado a un vehículo. ` +
          `No se registró; mándelo al grupo del vehículo.`);
      }

      // Fecha del viaje: la del manifiesto; si no se pudo leer, la del mensaje de Telegram (y el viaje queda en revisión)
      const fechaViaje = man.fecha_viaje || fechaBase;
      const notas = [];
      let estadoViaje = man.estado || 'confirmado';
      if (!man.fecha_viaje) {
        estadoViaje = 'revision';
        notas.push('Fecha no legible en el manifiesto: se usó la fecha del mensaje de Telegram');
      }
      if (man.fecha_corregida) {
        estadoViaje = 'revision';
        notas.push('Año corregido por posible error de OCR');
      }
      if (Array.isArray(man.advertencias)) notas.push(...man.advertencias);
      if (/claude/i.test(man._proveedor || '')) notas.push('Leído con Claude (respaldo)');

      const insV = await env.DB.prepare(`
        INSERT INTO viajes
          (numero, numero_manifiesto, fecha_viaje, vehiculo, conductor, origen, destino,
           empresa_carga, empresa_carga_nit, remitente, destinatario, mercancia, peso_kg,
           valor_flete, retefuente, reteica, otras_retenciones, valor_neto,
           anticipo, saldo_a_cobrar, archivo_r2, usuario, estado, notas, media_group_id)
        SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM viajes),
               ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
        RETURNING id, numero
      `).bind(
        man.numero_manifiesto, fechaViaje, vehManifiesto, man.conductor,
        man.origen, man.destino, man.empresa_carga, man.empresa_carga_nit,
        man.remitente, man.destinatario, man.mercancia, man.peso_kg || 0,
        man.valor_flete || 0, man.retefuente || 0, man.reteica || 0,
        man.otras_retenciones || 0, man.valor_neto || 0,
        man.anticipo || 0, man.saldo_a_cobrar || 0,
        r2Key, 'telegram',
        estadoViaje, notas.length ? notas.join(' · ') : null, mediaGroupId || null
      ).first();
      const numeroViaje = insV.numero;
      const viajeId = insV.id;

      // ── Auto-enlace de recibos: por álbum (media_group) si existe; si no, ventana corta de 3 min (no en un reintento) ──
      let enlazadosCount = 0;
      if (viajeId != null) {
        try {
          let upd;
          if (mediaGroupId) {
            upd = await env.DB.prepare(`UPDATE gastos SET viaje_id = ? WHERE media_group_id = ? AND viaje_id IS NULL`).bind(viajeId, mediaGroupId).run();
          } else if (vehManifiesto && !reintento) {
            upd = await env.DB.prepare(
              `UPDATE gastos SET viaje_id = ? WHERE vehiculo = ? AND viaje_id IS NULL AND creado_en >= datetime('now','-3 minutes')`
            ).bind(viajeId, vehManifiesto).run();
          }
          enlazadosCount = upd?.meta?.changes || 0;
        } catch {}
      }

      const vehTxtV = vehManifiesto ? `🚛 *${escapeMd(vehManifiesto)}*\n` : '⚠️ _Sin vehículo asignado_\n';
      const fechaTxtV = !man.fecha_viaje ? '\n\n⚠️ _Fecha no legible: se usó la del mensaje — revisa en el dashboard_'
        : man.fecha_corregida ? '\n\n⚠️ _Año corregido por posible error de OCR — revisa en el dashboard_' : '';
      const lowConfV = man.confianza_global === 'baja' ? '\n\n⚠️ _Confianza baja — revisa en el dashboard_' : '';
      await sendMessage(token, chatId,
        `🚚 *Viaje/Ingreso #${numeroViaje} registrado*\n\n` +
        vehTxtV +
        `Manifiesto: *${escapeMd(man.numero_manifiesto || '—')}*\n` +
        `Ruta: ${escapeMd(man.origen || '—')}→${escapeMd(man.destino || '—')}\n` +
        `Flete: ${fmtCOP(man.valor_flete)}\n` +
        `Anticipo: ${fmtCOP(man.anticipo)}\n` +
        `Saldo a cobrar: ${fmtCOP(man.saldo_a_cobrar)}` +
        (enlazadosCount > 0 ? `\n\n🔗 _${enlazadosCount} recibo(s) enlazado(s) a este viaje_` : '') +
        fechaTxtV +
        lowConfV
      );
      return { ok: true, resultado: `viaje #${numeroViaje}` };
    }

    const dup = await checkDuplicate(env.DB, preview.numero_documento, preview.total, preview.fecha, preview.proveedor_nit);
    if (dup) {
      const r = dup.registro;
      await sendMessage(token, chatId, `⚠️ *Duplicado*\n\nYa existe como #${r.numero} (${escapeMd(r.proveedor_nombre)} — ${fmtCOP(r.total)})\n\nNo se guardó.`);
      // En un reintento el archivo puede ser el del propio gasto ya registrado (falló después del INSERT): no se borra
      if (!reintento) { try { await env.BUCKET.delete(r2Key); } catch {} }
      return { ok: true, resultado: `duplicado de gasto #${r.numero}` };
    }

    // Vehículo: si el documento muestra una placa VÁLIDA de la flota distinta a la del grupo,
    // gana la placa del documento (reclasificación por placa). Si no hay placa, se queda la del grupo.
    const vehGrupo = vehiculo || null;
    const vehDoc = preview.vehiculo_detectado || preview.vehiculo || null;
    let vehFinal = vehGrupo || vehDoc || null;
    let reclasNota = '';
    if (vehDoc && VEHICULOS_FLOTA.includes(vehDoc) && vehGrupo && vehDoc !== vehGrupo) {
      vehFinal = vehDoc;
      reclasNota = ` · reclasificado por placa (grupo ${vehGrupo} → ${vehDoc})`;
    }

    preview.archivo_r2 = r2Key;
    const ins = await env.DB.prepare(`
      INSERT INTO gastos
        (numero, fecha, vehiculo, proveedor_nit, proveedor_nombre, numero_documento,
         concepto, categoria, valor_base, iva, inc, otros_impuestos,
         total, es_nota_credito, medio_pago, referencia_pago,
         kilometraje, ruta, archivo_r2, usuario, estado, notas, media_group_id)
      SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM gastos),
             ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      RETURNING id, numero
    `).bind(
      preview.fecha, vehFinal, preview.proveedor_nit, preview.proveedor_nombre,
      preview.numero_documento, preview.concepto, preview.categoria,
      preview.valor_base || 0, preview.iva || 0, preview.inc || 0,
      preview.otros_impuestos || 0, preview.total,
      preview.es_nota_credito ? 1 : 0,
      preview.medio_pago, preview.referencia_pago,
      preview.kilometraje || null, preview.ruta || null,
      preview.archivo_r2, usuario || 'telegram',
      'confirmado',  // auto-confirmado
      'Subido por Telegram' + reclasNota, mediaGroupId || null
    ).first();
    const numero = ins.numero;
    const gastoId = ins.id;

    // ── Auto-enlace: por álbum (media_group) si existe; si no, viaje reciente del mismo vehículo (3 min; no en un reintento) ──
    let viajeEnlazado = null;
    if (gastoId != null) {
      try {
        let viajeReciente = null;
        if (mediaGroupId) {
          viajeReciente = await env.DB.prepare('SELECT id, numero FROM viajes WHERE media_group_id = ? LIMIT 1').bind(mediaGroupId).first();
        }
        if (!viajeReciente && vehFinal && !reintento) {
          viajeReciente = await env.DB.prepare(
            `SELECT id, numero FROM viajes
               WHERE vehiculo = ? AND creado_en >= datetime('now','-3 minutes')
               ORDER BY creado_en DESC LIMIT 1`
          ).bind(vehFinal).first();
        }
        if (viajeReciente?.id != null) {
          await env.DB.prepare('UPDATE gastos SET viaje_id = ? WHERE id = ?')
            .bind(viajeReciente.id, gastoId).run();
          viajeEnlazado = viajeReciente.numero;
        }
      } catch {}
    }

    // Notificar por email (no bloquea)
    await notificarEmail(env, numero, vehFinal, preview);

    const vehTxt = vehFinal ? `🚛 *${escapeMd(vehFinal)}*${reclasNota ? ' 🔀 _reclasificado por placa_' : ''}\n` : '⚠️ _Sin vehículo asignado_\n';
    const lowConf = preview.confianza_global === 'baja' ? '\n\n⚠️ _Confianza baja — revisa en el dashboard_' : '';
    await sendMessage(token, chatId,
      `✅ *#${numero} guardado*\n\n` +
      vehTxt +
      `*${escapeMd(preview.proveedor_nombre)}*\n${fmtCOP(preview.total)}\n${escapeMd(preview.concepto)}\n\n` +
      `📁 ${escapeMd(preview.categoria)}\n📅 ${preview.fecha || '—'}` +
      (viajeEnlazado != null ? `\n🔗 _Enlazado al viaje #${viajeEnlazado}_` : '') +
      lowConf
    );
    return { ok: true, resultado: `gasto #${numero}` };
  } catch (err) {
    if (err && typeof err === 'object') err.tipoPendiente = tipo;
    throw err;
  } finally {
    console.log(`[TG] documento ${r2Key} (${tipo}${reintento ? ', reintento' : ''}) en ${Date.now() - t0}ms`);
  }
}

// ── Handler principal ─────────────────────────────────────
export async function handleTelegramUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromName = msg.from?.first_name || msg.from?.username || 'usuario';
  const usuario = (msg.from?.username || msg.from?.first_name || 'telegram').toLowerCase().replace(/[^\w]/g, '');
  const mediaGroupId = msg.media_group_id || null;
  const fechaMensaje = fechaBogota(msg.date);   // fecha del mensaje en Colombia: respaldo si el manifiesto no trae fecha legible

  const auth = await autorizar(env.DB, env, chatId);
  if (!auth.ok) {
    if (env.TELEGRAM_BOT_TOKEN && chatId) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        `🔒 Este chat no está vinculado a ningún vehículo.\n\nchat_id: \`${chatId}\`\n\nPídele al admin que lo configure en el dashboard → Vehículos.`);
    }
    return;
  }

  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    await handleMedia(env, chatId, photo.file_id, null, 'image/jpeg', usuario, auth.vehiculo, mediaGroupId, fechaMensaje);
    return;
  }

  if (msg.document) {
    const doc = msg.document;
    const mime = doc.mime_type || 'application/octet-stream';
    if (mime.startsWith('image/') || mime === 'application/pdf') {
      await handleMedia(env, chatId, doc.file_id, doc.file_name, mime, usuario, auth.vehiculo, mediaGroupId, fechaMensaje);
      return;
    }
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ Envía imagen (JPG/PNG) o PDF.`);
    return;
  }

  if (msg.text) {
    if (msg.text.startsWith('/')) await handleCommand(env, chatId, msg.text, fromName, auth);
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Envíame una *foto del gasto* o usa /help`);
    return;
  }
}

// ── Webhook utils ─────────────────────────────────────────
const WEBHOOK_BASE = 'https://tractomulas-gastos.ddropero.workers.dev';

export async function setupWebhook(env, webhookUrl, secretToken) {
  return tgRequest(env.TELEGRAM_BOT_TOKEN, 'setWebhook', {
    url: webhookUrl, secret_token: secretToken,
    allowed_updates: ['message', 'edited_message'], drop_pending_updates: true
  });
}

export async function checkWebhookHealth(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { healthy: false, reason: 'no_token' };
  try {
    const info = await tgRequest(token, 'getWebhookInfo', {});
    if (!info?.ok) return { healthy: false, reason: 'api_error', detail: info };
    const r = info.result || {};
    const expectedUrl = `${env.WORKER_URL || WEBHOOK_BASE}/api/telegram/webhook`;
    if (r.url !== expectedUrl) return { healthy: false, reason: 'wrong_url', current: r.url, expected: expectedUrl };
    if (r.last_error_date && (Date.now()/1000 - r.last_error_date) < 3600)
      return { healthy: false, reason: 'recent_error', last_error_message: r.last_error_message };
    if ((r.pending_update_count || 0) > 50) return { healthy: false, reason: 'too_many_pending', pending: r.pending_update_count };
    return { healthy: true, info: r };
  } catch (err) { return { healthy: false, reason: 'exception', detail: err.message }; }
}

export async function healWebhook(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  const webhookUrl = `${env.WORKER_URL || WEBHOOK_BASE}/api/telegram/webhook`;
  if (!token || !webhookSecret) return { ok: false, error: 'missing_secrets' };
  try {
    const result = await tgRequest(token, 'setWebhook', {
      url: webhookUrl, secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message'], drop_pending_updates: false
    });
    return { ok: !!result?.ok, result };
  } catch (err) { return { ok: false, error: err.message }; }
}
