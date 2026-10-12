// ============================================================
// Telegram Bot FLOTA — captura de gastos por vehículo
// 1 bot en 3 grupos. Cada grupo (chat_id) mapea a un vehículo
// en la tabla vehiculos.telegram_chat_id. Auto-confirmado.
// ============================================================

import { runOcrAgent } from './agent-router.js';
import { runManifiestoAgent } from './agent-manifiesto.js';

const TG_API = 'https://api.telegram.org';
const VEHICULOS_FLOTA = ['STT115', 'STT121', 'UPO707'];

async function tgRequest(token, method, body) {
  const res = await fetch(`${TG_API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function sendMessage(token, chatId, text, opts = {}) {
  return tgRequest(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'Markdown', ...opts });
}
async function sendChatAction(token, chatId, action = 'typing') {
  return tgRequest(token, 'sendChatAction', { chat_id: chatId, action });
}

function fmtCOP(n) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
}
function escapeMd(s) { return String(s || '').replace(/[_*`[\]]/g, '\\$&'); }

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

// ── Procesar foto/documento ───────────────────────────────
async function handleMedia(env, chatId, fileId, fileName, mimeType, usuario, vehiculo, mediaGroupId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  await sendChatAction(token, chatId, 'typing');

  const fileInfo = await tgRequest(token, 'getFile', { file_id: fileId });
  if (!fileInfo.ok) { await sendMessage(token, chatId, '❌ No pude obtener el archivo.'); return; }
  const filePath = fileInfo.result.file_path;
  const fileSize = fileInfo.result.file_size || 0;
  if (fileSize > 20 * 1024 * 1024) { await sendMessage(token, chatId, '❌ Archivo > 20MB.'); return; }

  const fileRes = await fetch(`${TG_API}/file/bot${token}/${filePath}`);
  if (!fileRes.ok) { await sendMessage(token, chatId, '❌ Error descargando.'); return; }
  const buf = await fileRes.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  const b64 = btoa(binary);

  let resolvedMime = mimeType;
  if (!resolvedMime || resolvedMime === 'application/octet-stream') {
    if (filePath.endsWith('.png')) resolvedMime = 'image/png';
    else if (filePath.endsWith('.pdf')) resolvedMime = 'application/pdf';
    else resolvedMime = 'image/jpeg';
  }

  const safeName = (fileName || filePath.split('/').pop() || 'telegram').replace(/[^\w.\-]/g, '_');
  const r2Key = `soportes/${Date.now()}-tg-${safeName}`;
  const r2Promise = env.BUCKET.put(r2Key, buf, { httpMetadata: { contentType: resolvedMime } });

  await sendChatAction(token, chatId, 'typing');
  const preview = await runOcrAgent(b64, resolvedMime, env, env.DB);
  await r2Promise;

  if (preview.error) { await sendMessage(token, chatId, `❌ Error procesando: ${preview.error}`); return; }

  // ── Hoja de control / consolidado del conductor → NO es gasto (evita doble conteo) ──
  if (preview && preview.es_planilla === true) {
    try { await env.BUCKET.delete(r2Key); } catch {}
    await sendMessage(token, chatId,
      `📋 *Hoja de control de viaje* detectada — es el resumen del conductor, *no se cuenta como gasto*.\n\n` +
      `Los gastos se toman de sus recibos individuales y el ingreso del manifiesto.`);
    return;
  }

  // ── Manifiesto electrónico de carga → tabla viajes (ingreso) ──
  if (preview && preview.es_manifiesto === true) {
    const man = await runManifiestoAgent(b64, resolvedMime, env.GEMINI_API_KEY, env.DB);
    if (man.error) { await sendMessage(token, chatId, `❌ Error procesando manifiesto: ${man.error}`); return; }

    let vehManifiesto = vehiculo || man.vehiculo || null;
    // Reclasificación por placa: si el manifiesto muestra una placa válida distinta a la del grupo, gana la del manifiesto
    if (man.vehiculo && VEHICULOS_FLOTA.includes(man.vehiculo) && vehiculo && man.vehiculo !== vehiculo) {
      vehManifiesto = man.vehiculo;
    }

    // ── Anti-duplicado: mismo álbum (media_group), o mismo manifiesto, o mismo flete+fecha+vehículo reciente ──
    let viajeDup = null;
    try {
      if (mediaGroupId) {
        viajeDup = await env.DB.prepare('SELECT id, numero FROM viajes WHERE media_group_id = ? LIMIT 1').bind(mediaGroupId).first();
      }
      if (!viajeDup && man.numero_manifiesto) {
        viajeDup = await env.DB.prepare('SELECT id, numero FROM viajes WHERE numero_manifiesto = ? LIMIT 1').bind(man.numero_manifiesto).first();
      }
      if (!viajeDup && vehManifiesto && man.fecha_viaje) {
        viajeDup = await env.DB.prepare(
          `SELECT id, numero FROM viajes
             WHERE vehiculo = ? AND fecha_viaje = ? AND ABS(valor_flete - ?) < 1000
               AND creado_en >= datetime('now','-30 minutes') LIMIT 1`
        ).bind(vehManifiesto, man.fecha_viaje, man.valor_flete || 0).first();
      }
    } catch {}
    if (viajeDup) {
      // Es un duplicado (otra página/copia del mismo manifiesto). No crear viaje nuevo;
      // enlazar al existente los recibos del mismo álbum.
      if (mediaGroupId) {
        try { await env.DB.prepare(`UPDATE gastos SET viaje_id = ? WHERE media_group_id = ? AND viaje_id IS NULL`).bind(viajeDup.id, mediaGroupId).run(); } catch {}
      }
      try { await env.BUCKET.delete(r2Key); } catch {}
      await sendMessage(token, chatId, `ℹ️ Este manifiesto ya está registrado como viaje #${viajeDup.numero} — no se duplicó.`);
      return;
    }

    const insV = await env.DB.prepare(`
      INSERT INTO viajes
        (numero, numero_manifiesto, fecha_viaje, vehiculo, conductor, origen, destino,
         empresa_carga, empresa_carga_nit, remitente, destinatario, mercancia, peso_kg,
         valor_flete, retefuente, reteica, otras_retenciones, valor_neto,
         anticipo, saldo_a_cobrar, archivo_r2, usuario, estado, media_group_id)
      SELECT (SELECT COALESCE(MAX(numero),0)+1 FROM viajes),
             ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
      RETURNING id, numero
    `).bind(
      man.numero_manifiesto, man.fecha_viaje, vehManifiesto, man.conductor,
      man.origen, man.destino, man.empresa_carga, man.empresa_carga_nit,
      man.remitente, man.destinatario, man.mercancia, man.peso_kg || 0,
      man.valor_flete || 0, man.retefuente || 0, man.reteica || 0,
      man.otras_retenciones || 0, man.valor_neto || 0,
      man.anticipo || 0, man.saldo_a_cobrar || 0,
      r2Key, 'telegram',
      man.estado || 'confirmado', mediaGroupId || null
    ).first();
    const numeroViaje = insV.numero;
    const viajeId = insV.id;

    // ── Auto-enlace de recibos: por álbum (media_group) si existe; si no, ventana corta de 3 min ──
    let enlazadosCount = 0;
    if (viajeId != null) {
      try {
        let upd;
        if (mediaGroupId) {
          upd = await env.DB.prepare(`UPDATE gastos SET viaje_id = ? WHERE media_group_id = ? AND viaje_id IS NULL`).bind(viajeId, mediaGroupId).run();
        } else if (vehManifiesto) {
          upd = await env.DB.prepare(
            `UPDATE gastos SET viaje_id = ? WHERE vehiculo = ? AND viaje_id IS NULL AND creado_en >= datetime('now','-3 minutes')`
          ).bind(viajeId, vehManifiesto).run();
        }
        enlazadosCount = upd?.meta?.changes || 0;
      } catch {}
    }

    const vehTxtV = vehManifiesto ? `🚛 *${escapeMd(vehManifiesto)}*\n` : '⚠️ _Sin vehículo asignado_\n';
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
      lowConfV
    );
    return;
  }

  const dup = await checkDuplicate(env.DB, preview.numero_documento, preview.total, preview.fecha, preview.proveedor_nit);
  if (dup) {
    const r = dup.registro;
    await sendMessage(token, chatId, `⚠️ *Duplicado*\n\nYa existe como #${r.numero} (${escapeMd(r.proveedor_nombre)} — ${fmtCOP(r.total)})\n\nNo se guardó.`);
    try { await env.BUCKET.delete(r2Key); } catch {}
    return;
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

  // ── Auto-enlace: por álbum (media_group) si existe; si no, viaje reciente del mismo vehículo (3 min) ──
  let viajeEnlazado = null;
  if (gastoId != null) {
    try {
      let viajeReciente = null;
      if (mediaGroupId) {
        viajeReciente = await env.DB.prepare('SELECT id, numero FROM viajes WHERE media_group_id = ? LIMIT 1').bind(mediaGroupId).first();
      }
      if (!viajeReciente && vehFinal) {
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
}

// ── Handler principal ─────────────────────────────────────
export async function handleTelegramUpdate(update, env) {
  const msg = update.message || update.edited_message;
  if (!msg) return;

  const chatId = msg.chat?.id;
  const fromName = msg.from?.first_name || msg.from?.username || 'usuario';
  const usuario = (msg.from?.username || msg.from?.first_name || 'telegram').toLowerCase().replace(/[^\w]/g, '');
  const mediaGroupId = msg.media_group_id || null;

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
    await handleMedia(env, chatId, photo.file_id, null, 'image/jpeg', usuario, auth.vehiculo, mediaGroupId);
    return;
  }

  if (msg.document) {
    const doc = msg.document;
    const mime = doc.mime_type || 'application/octet-stream';
    if (mime.startsWith('image/') || mime === 'application/pdf') {
      await handleMedia(env, chatId, doc.file_id, doc.file_name, mime, usuario, auth.vehiculo, mediaGroupId);
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
