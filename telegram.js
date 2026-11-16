// ============================================================
// Telegram Bot FLOTA — captura de gastos por vehículo
// 1 bot en 3 grupos. Cada grupo (chat_id) mapea a un vehículo
// en la tabla vehiculos.telegram_chat_id. Auto-confirmado.
// ============================================================

import { runOcrAgent } from './agent-router.js';
import { runManifiestoAgent } from './agent-manifiesto.js';
import { sha256Hex } from './auth.js';
import {
  placasFlota, placasDesdeD1, destinatarioAlertas, getEmpresa, etiquetaPlaca, versionTerminos, urlBase,
  esProduccion, contactoSoporte
} from './config-empresa.js';

const TG_API = 'https://api.telegram.org';
// Tipos de archivo que el bot acepta como documento (imágenes de mapa de bits y PDF)
const TIPOS_DOCUMENTO = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif', 'image/bmp', 'image/tiff',
  'application/pdf'
]);
// Las placas de la flota salen de config-empresa.js (placasFlota): la lista fija de siempre, o la tabla vehiculos con PLACAS_FUENTE="d1"

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
  // Con la flota en D1 (instancias con inscripción) un chat solo se autoriza por /start <código>: la vía de
  // vehiculos.telegram_chat_id se saltaría el /acepto del conductor y no dejaría constancia del consentimiento
  const veh = placasDesdeD1(env) ? null : await vehiculoDeChat(db, chatId);
  if (veh) return { ok: true, vehiculo: veh.placa, vehiculoNombre: veh.nombre };
  // Chats vinculados con /start <código> (tabla telegram_chats). Si la tabla no existe se sigue con la variable, como siempre
  try {
    const row = await db.prepare(
      'SELECT rol, placa, nombre, acepto_datos_en FROM telegram_chats WHERE chat_id = ? AND activo = 1'
    ).bind(String(chatId)).first();
    if (row) {
      let placa = row.placa || null;
      if (!placa && placasDesdeD1(env)) {
        const placas = await placasFlota(env);
        if (placas.length === 1) placa = placas[0];   // flota de una sola mula: el chat del dueño toma esa placa
      }
      return {
        ok: true,
        vehiculo: placa,
        vehiculoNombre: placa ? etiquetaPlaca(placa) : null,
        esAdmin: row.rol === 'dueno',
        rol: row.rol,
        nombreChat: row.nombre || null,
        pendienteAceptar: row.rol === 'conductor' && !row.acepto_datos_en
      };
    }
  } catch { /* sin tabla telegram_chats */ }
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
  const para = await destinatarioAlertas(env);   // producción: el de siempre; otras instancias: null si correo_alertas está apagada
  if (!para) return;
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
        to: [para],
        subject: `🚛 ${vehiculo || 'Flota'} — ${fmt(preview.total)} — ${preview.proveedor_nombre || preview.concepto || 'Gasto'}`,
        html
      })
    });
  } catch {}
}

// ── Ayuda del bot (SOLO fuera de producción) ──────────────
// En producción nada de esta sección se usa: los comandos y los textos de siempre no cambian.
// Todos estos mensajes van sin Markdown (SIN_FORMATO): llevan nombres que vienen de la base.

// Menú de comandos del bot (setMyCommands). El menú de todos los chats (COMANDOS_GLOBALES, sin /estado, que es solo
// del dueño) lo registra registrarComandos() al configurar el webhook; el completo se le pone al chat del dueño al vincularlo.
export const COMANDOS_BOT = [
  { command: 'ayuda', description: 'Cómo mandar las fotos' },
  { command: 'estado', description: 'Cómo va la mula este mes' },
  { command: 'total', description: 'Total de gastos del mes' },
  { command: 'ultimos', description: 'Últimos 5 gastos' }
];

export const COMANDOS_GLOBALES = COMANDOS_BOT.filter(c => c.command !== 'estado');

// Chat sin vincular (exportada para las pruebas). tablero = URL del tablero o null
export function textoChatSinVincular(tablero) {
  return 'Este chat todavía no está conectado.\n\n' +
    `Si usted es el dueño: entre al tablero${tablero ? ' (' + tablero + ')' : ''} y toque "Conectar mi Telegram".\n\n` +
    'Si es conductor: pídale el enlace al dueño de la mula y ábralo en este celular.';
}

const COMO_TOMAR_FOTO = 'el documento completo y derecho, con buena luz, sin sombras ni dedos encima, y un solo documento por foto';
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

// Resumen de qué mandar y cómo, distinto para el dueño y para el conductor (exportada para las pruebas).
// datos = { tablero: URL del tablero o null, contacto: a quién le escribe el dueño o null, responsable: nombre del dueño o null }
export function textoAyuda(rol, datos = {}) {
  if (rol === 'conductor') {
    return [
      'CÓMO MANDAR LAS FOTOS',
      '1. Manifiesto: foto completa y derecha, con buena luz, apenas se lo entreguen.',
      '2. Recibos de ACPM, peajes y gastos: una foto por cada recibo. No junte varios en una foto.',
      '3. Que se lean los números: sin sombras ni dedos encima.',
      '4. Yo le respondo en menos de un minuto con lo que leí.',
      '5. Si le digo que no pude leer la foto, tómela otra vez más clara. Si leí mal un valor, avísele al dueño: él lo corrige.',
      `6. ¿Dudas? Escríbale ${datos.responsable ? 'a ' + datos.responsable : 'al dueño de la flota'}.`
    ].join('\n');
  }
  return [
    'CÓMO USAR EL BOT',
    '1. Manifiesto: mándeme la foto completa y derecha, con buena luz. Que se lean el número, la placa y los valores.',
    '2. Gastos: una foto por cada recibo de ACPM, peaje o gasto. Un documento por foto.',
    '3. Yo le respondo en menos de un minuto con lo que leí: el viaje con su flete y su saldo, o el gasto con su valor.',
    `4. Si leí algo mal, corríjalo en el tablero${datos.tablero ? ': ' + datos.tablero : ''}. Si le digo que no pude leer la foto, tómela otra vez más clara.`,
    '5. /estado le dice cómo va la mula este mes. /total y /ultimos muestran los gastos.',
    `6. ¿Dudas? Escríbale a ${datos.contacto || 'quien le envió la invitación'}.`
  ].join('\n');
}

function urlTablero(env) {
  const base = urlBase(env, null);
  return base ? `${base}/dashboard.html` : null;
}

async function ayudaPara(env, rol) {
  if (rol === 'conductor') {
    let responsable = null;
    try { responsable = (await getEmpresa(env)).nombre || null; } catch {}
    return textoAyuda('conductor', { responsable });
  }
  return textoAyuda('dueno', { tablero: urlTablero(env), contacto: contactoSoporte(env) });
}

// Mensaje cuando el bot no pudo leer una foto (exportada para las pruebas). El motivo técnico queda en el log y en ocr_pendientes.
// caso: 'guardada' (se reintenta sola) | 'no_recibida' | 'pesada' | 'tipo' | 'abandonada'
export function avisoFotoNoLeida(caso) {
  if (caso === 'pesada') return 'Ese archivo pesa demasiado (más de 20 MB). Mándelo como foto, no como archivo.';
  if (caso === 'tipo') return 'Solo puedo leer fotos (JPG o PNG) o PDF. Mándeme una foto del documento.';
  if (caso === 'no_recibida') return `No pude recibir esta foto. Mándela otra vez, por favor: ${COMO_TOMAR_FOTO}.`;
  if (caso === 'abandonada') {
    return `No pude leer una foto que mandó antes, aunque lo intenté varias veces. Tómela otra vez, por favor: ${COMO_TOMAR_FOTO}.`;
  }
  return `No pude leer esta foto. Quedó guardada y la vuelvo a intentar ${CUANDO_REINTENTA}\n\n` +
    `Si quedó oscura, movida o cortada, mejor tómela otra vez: ${COMO_TOMAR_FOTO}.`;
}

const cuantos = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;

// Líneas de /estado (exportada para las pruebas). filas = [{ placa, viajes, gastos }]
export function textoEstado(mes, filas, pendientes, tablero) {
  const lineas = [`CÓMO VA ${String(mes).toUpperCase()}`];
  if (!filas.length) lineas.push('Todavía no hay vehículos registrados.');
  for (const f of filas) {
    lineas.push(`${etiquetaPlaca(f.placa)}: ${cuantos(f.viajes, 'viaje', 'viajes')} y ${cuantos(f.gastos, 'gasto', 'gastos')}.`);
  }
  lineas.push(pendientes > 0
    ? `Documentos pendientes de leer: ${pendientes}. Los vuelvo a intentar ${CUANDO_REINTENTA}`
    : 'Documentos pendientes de leer: ninguno.');
  if (tablero) lineas.push(`Qué transportadora le debe y cuánto le deja la mula: ${tablero}`);
  return lineas.join('\n');
}

// Viajes y gastos del mes (hora de Colombia) por placa, y documentos que el bot todavía no ha podido leer
async function estadoDelMes(env, auth) {
  const hoy = fechaBogota();
  const desde = `${hoy.slice(0, 7)}-01`;
  const placas = auth.vehiculo ? [auth.vehiculo] : await placasFlota(env);
  const n = async (sql, ...binds) => {
    try { return ((await env.DB.prepare(sql).bind(...binds).first()) || {}).n || 0; } catch { return 0; }
  };
  const filas = [];
  for (const placa of placas) {
    filas.push({
      placa,
      viajes: await n('SELECT COUNT(*) AS n FROM viajes WHERE vehiculo = ? AND fecha_viaje >= ?', placa, desde),
      gastos: await n('SELECT COUNT(*) AS n FROM gastos WHERE vehiculo = ? AND fecha >= ?', placa, desde)
    });
  }
  // La tabla ocr_pendientes se crea con la primera foto que falla: si no existe, no hay pendientes
  const pendientes = await n("SELECT COUNT(*) AS n FROM ocr_pendientes WHERE estado IN ('pendiente', 'procesando')");
  return textoEstado(MESES[Number(hoy.slice(5, 7)) - 1], filas, pendientes, urlTablero(env));
}

// Registra el menú de comandos del bot. En producción no hace nada (devuelve null); si no, true/false. Nunca lanza.
export async function registrarComandos(env) {
  if (esProduccion(env) || !env.TELEGRAM_BOT_TOKEN) return null;
  try {
    const r = await tgRequest(env.TELEGRAM_BOT_TOKEN, 'setMyCommands', { commands: COMANDOS_GLOBALES });
    if (!(r && r.ok)) console.warn('[TG] setMyCommands rechazado:', String((r && r.description) || '').slice(0, 200));
    return !!(r && r.ok);
  } catch (err) {
    console.warn('[TG] setMyCommands falló:', sinSecretos(err && err.message));
    return false;
  }
}

// Menú propio del chat según su rol: el del dueño lleva /estado; el del conductor vuelve al de todos.
// Solo fuera de producción. Nunca lanza: si Telegram lo rechaza, el chat queda con el menú de todos.
async function menuDelChat(env, chatId, rol) {
  if (esProduccion(env) || !env.TELEGRAM_BOT_TOKEN) return;
  const scope = { type: 'chat', chat_id: chatId };
  try {
    const r = rol === 'dueno'
      ? await tgRequest(env.TELEGRAM_BOT_TOKEN, 'setMyCommands', { commands: COMANDOS_BOT, scope })
      : await tgRequest(env.TELEGRAM_BOT_TOKEN, 'deleteMyCommands', { scope });
    if (!(r && r.ok)) console.warn('[TG] menú del chat rechazado:', String((r && r.description) || '').slice(0, 200));
  } catch (err) {
    console.warn('[TG] menú del chat falló:', sinSecretos(err && err.message));
  }
}

// ── Comandos ──────────────────────────────────────────────
async function handleCommand(env, chatId, text, fromName, auth) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const cmd = text.trim().split(' ')[0].toLowerCase().replace(/@\w+$/, '');
  const vehLabel = auth.vehiculoNombre ? ` (${auth.vehiculoNombre})` : '';
  const guiado = !esProduccion(env);   // ayuda nueva: solo fuera de producción

  if (guiado && (cmd === '/ayuda' || cmd === '/help' || cmd === '/start')) {
    await sendMessage(token, chatId, await ayudaPara(env, auth.rol), SIN_FORMATO);
    return;
  }

  if (guiado && cmd === '/estado') {
    if (auth.rol === 'conductor') {
      await sendMessage(token, chatId, 'Ese comando es para el dueño de la flota. Escriba /ayuda para ver cómo mandar las fotos.', SIN_FORMATO);
      return;
    }
    await sendMessage(token, chatId, await estadoDelMes(env, auth), SIN_FORMATO);
    return;
  }

  if (cmd === '/start' || cmd === '/help') {
    await sendMessage(token, chatId,
      `*Flota Gastos Bot* 🚛\n\n` +
      `Hola ${escapeMd(fromName)} 👋\n\n` +
      (auth.vehiculo
        ? `Este grupo está vinculado a *${escapeMd(auth.vehiculoNombre)}*.\n\nEnvía una *foto o PDF* de cualquier factura, peaje, recibo de combustible o gasto y lo registro automáticamente para este vehículo.\n\nTambién detecto *manifiestos electrónicos de carga* 🚚 y los registro como viajes/ingresos (flete, anticipo, saldo a cobrar).`
        : auth.rol === 'dueno'
          ? `Este chat está vinculado como dueño de la flota. Envíe aquí fotos o PDF de recibos, facturas y manifiestos.`
          : placasDesdeD1(env)
            ? `Este chat no está vinculado a un vehículo todavía. Abra el enlace de vinculación que le envió el dueño.`
            : `Tu chat no está vinculado a un vehículo todavía.`) +
      `\n\n*Comandos:*\n/total — Total del mes${vehLabel}\n/ultimos — Últimos 5 gastos\n/id — Ver el chat_id de este grupo\n/help — Ayuda`
    );
    return;
  }

  if (cmd === '/id') {
    await sendMessage(token, chatId,
      `🆔 *chat_id de este grupo:*\n\`${chatId}\`\n\n` +
      (auth.vehiculo ? `Vinculado a: *${escapeMd(auth.vehiculoNombre)}*`
        : placasDesdeD1(env) ? `_Sin vehículo. Abra el enlace de vinculación que le envió el dueño._`
        : `_Sin vehículo. Configúralo en el dashboard → Vehículos → pega este chat_id._`)
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

  // /acepto: el conductor autoriza el tratamiento de sus datos (Ley 1581 de 2012). Sin las tablas del piloto
  // (producción) no hace nada y sigue como cualquier comando desconocido
  if (cmd === '/acepto') {
    try {
      const fila = await env.DB.prepare(
        'SELECT rol, nombre, acepto_datos_en FROM telegram_chats WHERE chat_id = ? AND activo = 1'
      ).bind(String(chatId)).first();
      if (fila) {
        if (fila.rol !== 'conductor') {
          await sendMessage(token, chatId, 'Su autorización quedó registrada al inscribirse. No hace falta repetirla aquí.', SIN_FORMATO);
          return;
        }
        if (!fila.acepto_datos_en) {
          await env.DB.batch([
            env.DB.prepare("UPDATE telegram_chats SET acepto_datos_en = datetime('now') WHERE chat_id = ? AND acepto_datos_en IS NULL")
              .bind(String(chatId)),
            env.DB.prepare("INSERT INTO consentimientos (sujeto, tipo, version_texto, chat_id, nombre) VALUES ('conductor', 'datos_1581', ?, ?, ?)")
              .bind(versionTerminos(env), String(chatId), String(fila.nombre || fromName || '').slice(0, 80) || null)
          ]);
        }
        await sendMessage(token, chatId, guiado
          ? 'Gracias. Quedó registrada su autorización. Ya puede mandar las fotos.\n\n' + await ayudaPara(env, 'conductor')
          : 'Gracias. Quedó registrada su autorización. Ya puede enviar aquí las fotos de recibos, facturas y manifiestos.', SIN_FORMATO);
        return;
      }
    } catch (err) {
      console.warn('[TG] /acepto no disponible:', sinSecretos(err && err.message));
    }
  }

  if (guiado) {
    await sendMessage(token, chatId, 'No conozco ese comando. Escriba /ayuda para ver cómo mandar las fotos.', SIN_FORMATO);
    return;
  }
  await sendMessage(token, chatId, 'Envíame una *foto* del gasto o usa /help');
}

// ── Vinculación de chats por /start <código> ──────────────
// TEXTO PENDIENTE DE APROBACIÓN DEL DUEÑO: borrador del aviso de tratamiento de datos que recibe el conductor.
// Si cambia, subir TERMINOS_VERSION.
function avisoDatosConductor(responsable, version) {
  return 'AVISO DE TRATAMIENTO DE DATOS PERSONALES (Ley 1581 de 2012)\n\n' +
    `Responsable: ${responsable}.\n` +
    'Datos que se tratan: su nombre, su usuario e identificador de Telegram, y las fotos y documentos que usted envíe a este chat ' +
    '(recibos, facturas y manifiestos de carga), que pueden traer su nombre y su número de cédula.\n' +
    'Finalidad: registrar los gastos y los viajes del vehículo y llevar las cuentas de la operación. ' +
    'Las imágenes se leen con servicios automáticos de reconocimiento de texto prestados por terceros.\n' +
    'Sus derechos: conocer, actualizar, rectificar y pedir que se supriman sus datos, y revocar esta autorización, ' +
    'escribiéndole al responsable.\n' +
    `Versión del texto: ${version}`;
}

// Devuelve 'vinculado' | 'invalido' | 'error' | 'no_disponible' (sin las tablas del piloto: quien llama sigue como siempre).
// El código nunca se guarda ni se registra en claro: solo su hash.
async function vincularChat(env, chatId, codigo, from, chat) {
  const token = env.TELEGRAM_BOT_TOKEN;
  let hash, reclamo;
  try {
    hash = await sha256Hex(codigo);
    // Reclamo atómico: un código sirve una sola vez y solo antes de vencer
    reclamo = await env.DB.prepare(
      `UPDATE telegram_vinculos SET usado_en = datetime('now'), chat_id = ?
        WHERE codigo_hash = ? AND usado_en IS NULL AND expira_en > datetime('now')`
    ).bind(String(chatId), hash).run();
  } catch {
    return 'no_disponible';
  }
  if (!(reclamo && reclamo.meta && reclamo.meta.changes === 1)) {
    // Mismo mensaje si no existe, ya se usó o venció
    await sendMessage(token, chatId,
      'Este enlace de vinculación no es válido, ya se usó o venció. Pídale uno nuevo al dueño de la flota.', SIN_FORMATO);
    return 'invalido';
  }

  let v;
  try {
    v = await env.DB.prepare('SELECT rol, placa, nombre FROM telegram_vinculos WHERE codigo_hash = ?').bind(hash).first();
    if (!v) throw new Error('vínculo no encontrado tras reclamarlo');
    await env.DB.prepare(
      `INSERT INTO telegram_chats (chat_id, rol, placa, nombre, tg_user_id, tg_username, activo, vinculado_en, acepto_datos_en)
       VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), NULL)
       ON CONFLICT(chat_id) DO UPDATE SET
         rol = excluded.rol, placa = excluded.placa, nombre = excluded.nombre,
         tg_user_id = excluded.tg_user_id, tg_username = excluded.tg_username,
         activo = 1, vinculado_en = datetime('now'), acepto_datos_en = NULL`
    ).bind(
      String(chatId), v.rol, v.placa || null, v.nombre || null,
      from && from.id != null ? String(from.id) : null,
      from && from.username ? String(from.username).slice(0, 64) : null
    ).run();
  } catch (err) {
    console.error('[TG] vinculación falló:', sinSecretos(err && err.message));
    // Se libera el código para que el enlace siga sirviendo
    try {
      await env.DB.prepare('UPDATE telegram_vinculos SET usado_en = NULL, chat_id = NULL WHERE codigo_hash = ?').bind(hash).run();
    } catch {}
    await sendMessage(token, chatId, 'No pude completar la vinculación. Intente de nuevo en un momento.', SIN_FORMATO);
    return 'error';
  }

  const placaTxt = v.placa ? etiquetaPlaca(v.placa) : null;
  if (!esProduccion(env)) {
    await menuDelChat(env, chatId, v.rol);
    // Bienvenida con los 3 pasos que siguen para ese rol
    if (v.rol === 'dueno') {
      await sendMessage(token, chatId,
        `Listo. Este chat quedó conectado como dueño${placaTxt ? ' (' + placaTxt + ')' : ''}.\n\n` +
        'Los 3 pasos que siguen:\n' +
        '1. Mande aquí la foto del primer manifiesto: completa, derecha y con buena luz.\n' +
        '2. Mande una foto por cada recibo de ese viaje (ACPM, peajes, gastos).\n' +
        '3. Mándele a su conductor por WhatsApp el enlace que le salió al inscribirse. Si lo perdió, pida otro en el tablero.\n\n' +
        'Escriba /ayuda cuando quiera repasar cómo tomar las fotos.', SIN_FORMATO);
    } else {
      let responsable = 'el dueño de la flota';
      try { responsable = (await getEmpresa(env)).nombre || responsable; } catch {}
      await sendMessage(token, chatId,
        `Hola. Este chat quedó conectado como conductor${placaTxt ? ' de ' + placaTxt : ''}.\n\n` +
        'Los 3 pasos que siguen:\n' +
        '1. Lea el aviso de abajo.\n' +
        '2. Responda /acepto para autorizar.\n' +
        '3. Mande la foto del manifiesto y una foto por cada recibo de ACPM, peaje o gasto.\n\n' +
        avisoDatosConductor(responsable, versionTerminos(env)) +
        '\n\nPara autorizar y empezar a mandar fotos, responda /acepto', SIN_FORMATO);
    }
    return 'vinculado';
  }
  if (v.rol === 'dueno') {
    await sendMessage(token, chatId,
      `Listo. Este chat quedó vinculado como dueño${placaTxt ? ' (' + placaTxt + ')' : ''}.\n\n` +
      'Envíe aquí fotos o PDF de recibos, facturas y manifiestos de carga y quedan registrados. Use /help para ver los comandos.', SIN_FORMATO);
  } else {
    let responsable = 'el dueño de la flota';
    try { responsable = (await getEmpresa(env)).nombre || responsable; } catch {}
    await sendMessage(token, chatId,
      `Hola. Este chat quedó vinculado como conductor${placaTxt ? ' de ' + placaTxt : ''}.\n\n` +
      avisoDatosConductor(responsable, versionTerminos(env)) +
      '\n\nPara autorizar y empezar a enviar fotos, responda /acepto', SIN_FORMATO);
  }
  return 'vinculado';
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
  if (!esProduccion(env)) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, fila.chat_id, avisoFotoNoLeida('abandonada'), SIN_FORMATO);
    return;
  }
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
async function handleMedia(env, chatId, fileId, fileName, mimeType, usuario, vehiculo, mediaGroupId, fechaMensaje, chat = {}) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const t0 = Date.now();
  await sendChatAction(token, chatId, 'typing');
  // Fuera de producción los avisos de fallo dicen cómo volver a tomar la foto (el motivo técnico queda en el log)
  const guiado = !esProduccion(env);
  const fallo = (caso, original) => (guiado
    ? sendMessage(token, chatId, avisoFotoNoLeida(caso), SIN_FORMATO)
    : sendMessage(token, chatId, original));

  let b64, resolvedMime, r2Key;
  try {
    const fileInfo = await tgRequest(token, 'getFile', { file_id: fileId });
    if (!fileInfo.ok) { await fallo('no_recibida', '❌ No pude obtener el archivo.'); return; }
    const filePath = fileInfo.result.file_path;
    const fileSize = fileInfo.result.file_size || 0;
    if (fileSize > 20 * 1024 * 1024) { await fallo('pesada', '❌ Archivo > 20MB.'); return; }

    const fileRes = await fetch(`${TG_API}/file/bot${token}/${filePath}`);
    if (!fileRes.ok) { await fallo('no_recibida', '❌ Error descargando.'); return; }
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
    await sendMessage(token, chatId, guiado
      ? avisoFotoNoLeida('no_recibida')
      : `No pude descargar o guardar esta foto (${motivoCorto(err)}). Envíela de nuevo, por favor.`, SIN_FORMATO);
    return;
  }

  try {
    await procesarDocumento(env, { chatId, b64, mime: resolvedMime, r2Key, usuario, vehiculo, mediaGroupId, fechaMensaje, t0,
      nombreChat: chat.nombreChat || null, rolChat: chat.rolChat || null });
  } catch (err) {
    // Antes esto solo iba a console.error y el grupo nunca se enteraba
    console.error('[TG] error procesando', r2Key, err && err.stack || err);
    const motivo = motivoCorto(err);
    await registrarPendiente(env, {
      chatId, vehiculo, usuario, mediaGroupId, fechaMensaje, r2Key, mime: resolvedMime,
      tipo: (err && err.tipoPendiente) || 'documento', motivo
    });
    await sendMessage(token, chatId, guiado
      ? avisoFotoNoLeida('guardada')
      : `No pude procesar esta foto (${motivo}). Quedó guardada y se reintenta sola ${CUANDO_REINTENTA}; si no aparece en el dashboard avise.`, SIN_FORMATO);
  }
}

// Todo lo que pasa DESPUÉS de tener el archivo descargado y guardado en R2: OCR y registro como planilla,
// manifiesto (viaje) o gasto.
// doc = { chatId, b64, mime, r2Key, usuario, vehiculo, mediaGroupId, fechaMensaje, t0, reintento?, tipoConocido?, nombreChat?, rolChat? }
// nombreChat / rolChat: nombre y rol del chat vinculado por /start (tabla telegram_chats); sin ellos, todo como siempre.
// En un reintento (reintento: true) el auto-enlace de recibos↔viaje es SOLO por media_group_id: las ventanas de 3 minutos miden
// contra "ahora" (la hora del reintento), no contra la hora en que el conductor mandó la foto, y enlazarían documentos de días distintos.
// tipoConocido: 'manifiesto' → ya se sabe que lo es (pendiente de un manifiesto) y no se vuelve a clasificar.
// Devuelve { ok: true, resultado } o { pendiente: true, motivo } (este último ya quedó registrado en ocr_pendientes).
// Si algo se rompe lanza, con err.tipoPendiente: quien llama lo registra como pendiente.
export async function procesarDocumento(env, doc) {
  const { chatId, b64, mime, r2Key, usuario, vehiculo, mediaGroupId, fechaMensaje, reintento, tipoConocido, nombreChat, rolChat } = doc;
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

    // Flota de esta instancia. Sin PLACAS_FUENTE="d1" es la lista fija de siempre y a los agentes no se les pasa nada nuevo
    const flotaD1 = placasDesdeD1(env);
    const placas = await placasFlota(env);
    const optsPlacas = flotaD1 ? { placas } : {};

    // Con Gemini caído la clasificación cae a Sonnet y, si era un manifiesto, la extracción sería una 2.ª llamada a Claude EN SERIE
    // bajo el mismo presupuesto de 26 s: no cabe de forma fiable. Por eso, en cuanto la clasificación cae a Sonnet porque Gemini
    // falló, la extracción arranca EN PARALELO (directo a Claude: Gemini acaba de fallar con esta foto). Si el documento no resulta
    // ser un manifiesto ese resultado se descarta (cuesta una llamada de más, solo mientras Gemini está caído)
    const extraerManifiesto = (extra = {}) =>
      runManifiestoAgent(b64, mime, env.GEMINI_API_KEY, env.DB, { anthropicKey: env.ANTHROPIC_API_KEY, deadline, ...optsPlacas, ...extra });
    let manAdelantado = null;
    const alCaerASonnet = () => {
      if (!env.ANTHROPIC_API_KEY || manAdelantado) return;
      manAdelantado = extraerManifiesto({ sinGemini: true });
      manAdelantado.catch(() => {});   // si nadie la espera (no era manifiesto) que no quede como rechazo sin capturar
    };

    // Un reintento de un manifiesto ya clasificado no gasta otra llamada de clasificación (ni su tiempo)
    const preview = tipoConocido === 'manifiesto'
      ? { es_manifiesto: true }
      : await runOcrAgent(b64, mime, env, env.DB, { deadline, alCaerASonnet, ...optsPlacas });

    if (preview.error) {
      const detalle = preview._ocr_fallback_reason ? `${preview.error} (gemini: ${preview._ocr_fallback_reason})` : preview.error;
      return await dejarPendiente('documento', detalle, esProduccion(env)
        ? `❌ Error procesando: ${preview.error}\n\nLa foto quedó guardada y se reintenta sola ${CUANDO_REINTENTA}; si no aparece en el dashboard avise.`
        : avisoFotoNoLeida('guardada'));
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
        return await dejarPendiente('manifiesto', man.error, esProduccion(env)
          ? `❌ Error procesando manifiesto: ${man.error}\n\nQuedó guardado y se reintenta solo ${CUANDO_REINTENTA}; si no aparece en el dashboard avise.`
          : avisoFotoNoLeida('guardada'));
      }

      let vehManifiesto = vehiculo || man.vehiculo || null;
      // Reclasificación por placa: si el manifiesto muestra una placa válida distinta a la del grupo, gana la del manifiesto
      if (man.vehiculo && placas.includes(man.vehiculo) && vehiculo && man.vehiculo !== vehiculo) {
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
        man.numero_manifiesto, fechaViaje, vehManifiesto, man.conductor || (rolChat === 'conductor' && nombreChat ? nombreChat : null),
        man.origen, man.destino, man.empresa_carga, man.empresa_carga_nit,
        man.remitente, man.destinatario, man.mercancia, man.peso_kg || 0,
        man.valor_flete || 0, man.retefuente || 0, man.reteica || 0,
        man.otras_retenciones || 0, man.valor_neto || 0,
        man.anticipo || 0, man.saldo_a_cobrar || 0,
        r2Key, nombreChat || 'telegram',
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
    const vehLeido = preview.vehiculo_detectado || preview.vehiculo || null;
    // Con la flota en D1 solo cuenta una placa de la flota (una placa ajena no reclasifica ni se guarda como vehículo)
    const vehDoc = flotaD1 ? (placas.includes(vehLeido) ? vehLeido : null) : vehLeido;
    let vehFinal = vehGrupo || vehDoc || null;
    let reclasNota = '';
    if (vehDoc && placas.includes(vehDoc) && vehGrupo && vehDoc !== vehGrupo) {
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

  // /start <código> (o /start@bot <código> en un grupo): vincula este chat con el rol y la placa del código.
  // Sin las tablas del piloto (producción) vincularChat devuelve 'no_disponible' y todo sigue como siempre.
  const mVinculo = typeof msg.text === 'string' ? /^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{8,64})$/.exec(msg.text.trim()) : null;
  if (mVinculo && env.TELEGRAM_BOT_TOKEN && chatId != null) {
    const res = await vincularChat(env, chatId, mVinculo[1], msg.from, msg.chat);
    if (res !== 'no_disponible') return;
  }

  const auth = await autorizar(env.DB, env, chatId);
  if (!auth.ok) {
    if (env.TELEGRAM_BOT_TOKEN && chatId) {
      // Fuera de producción el mensaje dice qué hacer según quién escribe (el dueño saca su enlace en el tablero)
      if (!esProduccion(env)) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, textoChatSinVincular(urlTablero(env)), SIN_FORMATO);
      else await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, placasDesdeD1(env)
        ? `🔒 Este chat no está vinculado.\n\nAbra el enlace de vinculación que le envió el dueño de la flota.`
        : `🔒 Este chat no está vinculado a ningún vehículo.\n\nchat_id: \`${chatId}\`\n\nPídele al admin que lo configure en el dashboard → Vehículos.`);
    }
    return;
  }

  // Chat vinculado por /start: el registro lleva el nombre con el que el dueño lo inscribió
  const usuarioReg = auth.nombreChat ? String(auth.nombreChat).slice(0, 80) : usuario;
  const datosChat = { nombreChat: auth.nombreChat || null, rolChat: auth.rol || null };

  // El conductor debe autorizar el tratamiento de sus datos (/acepto) antes de que se procese nada suyo
  if (auth.pendienteAceptar && ((msg.photo && msg.photo.length > 0) || msg.document)) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      'Antes de registrar sus documentos necesito su autorización para el tratamiento de datos. Lea el aviso de arriba y responda /acepto. Luego envíe la foto de nuevo.',
      SIN_FORMATO);
    return;
  }

  if (msg.photo && msg.photo.length > 0) {
    const photo = msg.photo[msg.photo.length - 1];
    await handleMedia(env, chatId, photo.file_id, null, 'image/jpeg', usuarioReg, auth.vehiculo, mediaGroupId, fechaMensaje, datosChat);
    return;
  }

  if (msg.document) {
    const doc = msg.document;
    const mime = doc.mime_type || 'application/octet-stream';
    // Fuera de producción, lista cerrada: image/svg+xml y otros formatos con contenido activo no se guardan ni se sirven.
    // Producción acepta lo mismo de siempre (cualquier image/* o PDF).
    const aceptado = esProduccion(env)
      ? (mime.startsWith('image/') || mime === 'application/pdf')
      : TIPOS_DOCUMENTO.has(mime.toLowerCase());
    if (aceptado) {
      await handleMedia(env, chatId, doc.file_id, doc.file_name, mime, usuarioReg, auth.vehiculo, mediaGroupId, fechaMensaje, datosChat);
      return;
    }
    if (!esProduccion(env)) await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, avisoFotoNoLeida('tipo'), SIN_FORMATO);
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `❌ Envía imagen (JPG/PNG) o PDF.`);
    return;
  }

  if (msg.text) {
    if (msg.text.startsWith('/')) await handleCommand(env, chatId, msg.text, fromName, auth);
    else if (!esProduccion(env)) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        'Mándeme la foto del manifiesto o del recibo. Escriba /ayuda para ver cómo tomarla.', SIN_FORMATO);
    }
    else await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `Envíame una *foto del gasto* o usa /help`);
    return;
  }
}

// ── Webhook utils ─────────────────────────────────────────
// Respaldo SOLO para producción. Otras instancias deben definir WORKER_URL: sin ella no se registra ni se repara el webhook
// (si no, el cron re-apuntaría el bot de esa instancia al Worker de producción)
const WEBHOOK_BASE = 'https://tractomulas-gastos.ddropero.workers.dev';

export async function setupWebhook(env, webhookUrl, secretToken) {
  const r = await tgRequest(env.TELEGRAM_BOT_TOKEN, 'setWebhook', {
    url: webhookUrl, secret_token: secretToken,
    allowed_updates: ['message', 'edited_message'], drop_pending_updates: true
  });
  // Fuera de producción se registra además el menú de comandos del bot (en producción la respuesta es la de siempre)
  if (r && r.ok && !esProduccion(env)) r.comandos = await registrarComandos(env);
  return r;
}

export async function checkWebhookHealth(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return { healthy: false, reason: 'no_token' };
  const base = urlBase(env, WEBHOOK_BASE);
  if (!base) return { healthy: false, reason: 'sin_worker_url' };
  try {
    const info = await tgRequest(token, 'getWebhookInfo', {});
    if (!info?.ok) return { healthy: false, reason: 'api_error', detail: info };
    const r = info.result || {};
    const expectedUrl = `${base}/api/telegram/webhook`;
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
  const base = urlBase(env, WEBHOOK_BASE);
  if (!base) return { ok: false, error: 'sin_worker_url' };
  const webhookUrl = `${base}/api/telegram/webhook`;
  if (!token || !webhookSecret) return { ok: false, error: 'missing_secrets' };
  try {
    const result = await tgRequest(token, 'setWebhook', {
      url: webhookUrl, secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message'], drop_pending_updates: false
    });
    if (result?.ok && !esProduccion(env)) return { ok: true, result, comandos: await registrarComandos(env) };
    return { ok: !!result?.ok, result };
  } catch (err) { return { ok: false, error: err.message }; }
}
