// ============================================================
// Inscripción del piloto, configuración pública y vinculación de Telegram
// Rutas (todas devuelven JSON con las cabeceras CORS de worker.js):
//   GET    /api/config-publica
//   POST   /api/admin/invitaciones        (x-admin-token)
//   POST   /api/inscripcion/validar
//   POST   /api/inscripcion
//   POST   /api/vinculacion-telegram      (sesión de administrador)
//   GET    /api/telegram/chats            (sesión de administrador)
//   DELETE /api/telegram/chats/:chat_id   (sesión de administrador)
//   GET    /api/primeros-pasos            (sesión)
//   POST   /api/primeros-pasos            (sesión de administrador)  marcar | desmarcar | ocultar | mostrar
// Las de inscripción solo existen con INSCRIPCION="on". Nunca se registra en logs el código de invitación,
// la contraseña ni el cuerpo de la petición.
// ============================================================

import {
  hashPassword, sha256Hex, createSession, generateSessionToken, constantTimeEqual, verifyRequest
} from './auth.js';
import {
  funciones, esProduccion, vehiculosFlota, getEmpresa, invalidarEmpresa, asegurarEsquema, asegurarEsquemaGuia,
  normalizarPlaca, etiquetaPlaca, versionTerminos, urlBase, placasDesdeD1, placasFlota
} from './config-empresa.js';
import { healWebhook } from './telegram.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-token',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra }
  });
}

const MAX_CUERPO = 10 * 1024;          // 10 KB
const INTENTOS_IP = 5;                 // fallos por IP...
const VENTANA_IP_S = 15 * 60;          // ...en 15 minutos
// No hay tope global: con él cualquiera podía cerrarle la inscripción al invitado mandando códigos inventados.
// El código tiene 24 caracteres al azar (144 bits): adivinarlo no es viable ni sin tope.
const DIAS_VINCULO = 7;
const TTL_SESION_INSCRIPCION_MS = 20 * 60 * 1000;   // sesión temporal tras inscribirse: da tiempo de instalar la app de códigos
const MSG_BASE_SUCIA = 'La base de esta instancia ya tiene vehículos de otra empresa. Cree una base nueva y aplique solo schema-base-piloto.sql y schema-piloto.sql (npm run db:piloto).';
const MSG_INVITACION = 'Invitación inválida o vencida';
const MSG_NO_ACTIVA = 'La inscripción no está activa en esta instancia';

// ── Utilidades puras (exportadas para las pruebas) ────────
// 'YYYY-MM-DD HH:MM:SS' en UTC: el mismo formato que datetime('now') de SQLite, para poder compararlas como texto
export function fechaSql(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

export function nuevoCodigoInvitacion() { return generateSessionToken().slice(0, 24); }
export function nuevoCodigoVinculo() { return generateSessionToken().slice(0, 22); }   // base64url: válido como parámetro start de t.me

export function codigoBienFormado(c) {
  return typeof c === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(c);
}

// Comparación en tiempo constante sin filtrar el largo: se comparan los hashes
export async function igualSeguro(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  return constantTimeEqual(ha, hb);
}

const sinControl = s => String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

// Valida y normaliza el cuerpo de POST /api/inscripcion.
// Devuelve { ok: true, datos } o { ok: false, campos: { campo: motivo } }
export function validarInscripcion(body, versionEsperada) {
  const campos = {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};

  if (!codigoBienFormado(b.codigo)) campos.codigo = 'Código de invitación con formato inválido';

  const empresa = typeof b.empresa_nombre === 'string' ? sinControl(b.empresa_nombre) : '';
  if (empresa.length < 3 || empresa.length > 120) campos.empresa_nombre = 'Entre 3 y 120 caracteres';

  const docTipo = b.documento_tipo;
  if (docTipo !== 'NIT' && docTipo !== 'CC') campos.documento_tipo = 'Debe ser NIT o CC';

  const documento = typeof b.documento === 'string' ? b.documento.trim() : '';
  if (!/^(?=.{5,15}$)\d+(-\d)?$/.test(documento)) campos.documento = 'Solo dígitos (y guion del dígito de verificación), de 5 a 15 caracteres';

  const correo = typeof b.correo === 'string' ? b.correo.trim().toLowerCase() : '';
  if (correo.length > 254 || !/^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/.test(correo)) campos.correo = 'Correo inválido';

  const celular = typeof b.celular === 'string' ? b.celular.replace(/[\s-]/g, '') : '';
  if (!/^3\d{9}$/.test(celular)) campos.celular = 'Celular de 10 dígitos que empiece por 3';

  const password = b.password;
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) campos.password = 'Entre 10 y 128 caracteres';

  let placas = [];
  if (!Array.isArray(b.placas) || b.placas.length < 1 || b.placas.length > 3) {
    campos.placas = 'De 1 a 3 placas';
  } else {
    placas = b.placas.map(normalizarPlaca);
    if (placas.some(p => !p)) campos.placas = 'Cada placa debe tener la forma AAA123';
    else if (new Set(placas).size !== placas.length) campos.placas = 'Hay placas repetidas';
  }

  let conductor = null;
  if (b.conductor != null) {
    if (typeof b.conductor !== 'object' || Array.isArray(b.conductor)) {
      campos.conductor = 'Formato inválido';
    } else {
      const nombre = typeof b.conductor.nombre === 'string' ? sinControl(b.conductor.nombre) : '';
      const cel = b.conductor.celular == null || b.conductor.celular === '' ? null
        : (typeof b.conductor.celular === 'string' ? b.conductor.celular.replace(/[\s-]/g, '') : '?');
      if (nombre.length < 3 || nombre.length > 80) campos['conductor.nombre'] = 'Entre 3 y 80 caracteres';
      if (cel !== null && !/^3\d{9}$/.test(cel)) campos['conductor.celular'] = 'Celular de 10 dígitos que empiece por 3';
      conductor = { nombre, celular: cel };
    }
  }

  let transportadoras = [];
  if (b.transportadoras != null) {
    if (!Array.isArray(b.transportadoras) || b.transportadoras.length > 10) {
      campos.transportadoras = 'Máximo 10';
    } else if (b.transportadoras.some(t => typeof t !== 'string' || sinControl(t).length > 80)) {
      campos.transportadoras = 'Cada nombre debe ser texto de máximo 80 caracteres';
    } else {
      transportadoras = b.transportadoras.map(sinControl).filter(Boolean);
    }
  }

  if (b.acepta_terminos !== true) campos.acepta_terminos = 'Debe aceptar los términos del piloto';
  if (b.acepta_datos !== true) campos.acepta_datos = 'Debe autorizar el tratamiento de datos';
  if (b.version_terminos !== versionEsperada) campos.version_terminos = 'La versión de los términos cambió; recargue la página';

  if (Object.keys(campos).length) return { ok: false, campos };
  return {
    ok: true,
    datos: { codigo: b.codigo, empresa, docTipo, documento, correo, celular, password, placas, conductor, transportadoras }
  };
}

// ── Límite de intentos (tabla intentos_inscripcion) ───────
async function hashIp(request) {
  return sha256Hex('ip:' + (request.headers.get('CF-Connecting-IP') || 'desconocida'));
}

// null si puede seguir; si no, los segundos que debe esperar. Solo cuenta los fallos de esa IP:
// quien trae una invitación vigente nunca llega aquí (el límite se aplica cuando la invitación falla).
async function limiteSuperado(env, ipHash) {
  const porIp = await env.DB.prepare(
    `SELECT COUNT(*) AS n, CAST(strftime('%s','now') - strftime('%s', MIN(creado_en)) AS INTEGER) AS edad
       FROM intentos_inscripcion WHERE ip_hash = ? AND ruta IN ('validar', 'inscripcion') AND creado_en > datetime('now', ?)`
  ).bind(ipHash, `-${VENTANA_IP_S} seconds`).first();
  if (porIp && porIp.n >= INTENTOS_IP) return Math.max(1, VENTANA_IP_S - (porIp.edad || 0));
  return null;
}

// Respuesta cuando la invitación no sirve: 429 si esa IP ya agotó sus intentos; si no, anota el fallo y responde 403
async function invitacionRechazada(env, ipHash, ruta) {
  const espera = await limiteSuperado(env, ipHash);
  if (espera) return demasiadosIntentos(espera);
  await registrarFallo(env, ipHash, ruta);
  return json({ error: MSG_INVITACION }, 403);
}

// Con la flota en D1, la tabla vehiculos debe estar vacía antes de inscribir: si trae filas es que se aplicó
// schema.sql (que siembra las placas de producción) en vez de schema-base-piloto.sql
async function baseConVehiculosAjenos(env) {
  if (!placasDesdeD1(env)) return false;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM vehiculos').first();
  return !!row && row.n > 0;
}

async function registrarFallo(env, ipHash, ruta) {
  try {
    await env.DB.prepare('INSERT INTO intentos_inscripcion (ip_hash, ruta) VALUES (?, ?)').bind(ipHash, ruta).run();
  } catch (err) {
    console.error('[INSCRIPCION] no pude registrar el intento:', err && err.message);
  }
}

function demasiadosIntentos(espera) {
  return json({ error: 'Demasiados intentos. Espere antes de volver a intentar.', retry_after_s: espera }, 429,
    { 'Retry-After': String(espera) });
}

// Fila de la invitación si existe, no se ha usado y no venció; si no, null. No la reclama.
async function invitacionVigente(env, codigo) {
  if (!codigoBienFormado(codigo)) return null;
  const hash = await sha256Hex(codigo);
  const row = await env.DB.prepare(
    "SELECT codigo_hash, expira_en FROM invitaciones WHERE codigo_hash = ? AND usada_en IS NULL AND expira_en > datetime('now')"
  ).bind(hash).first();
  if (!row || !constantTimeEqual(String(row.codigo_hash), hash)) return null;
  return { hash, expira_en: row.expira_en };
}

async function hayEmpresa(env) {
  const row = await env.DB.prepare('SELECT id FROM config_empresa WHERE id = 1').first();
  return !!row;
}

// Lee el cuerpo JSON con tope de tamaño. Devuelve { body } o { respuesta } (error ya armado)
async function leerJson(request) {
  const declarado = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (declarado > MAX_CUERPO) return { respuesta: json({ error: 'Cuerpo demasiado grande' }, 413) };
  let texto;
  try { texto = await request.text(); } catch { return { respuesta: json({ error: 'No se pudo leer la petición' }, 400) }; }
  if (texto.length > MAX_CUERPO) return { respuesta: json({ error: 'Cuerpo demasiado grande' }, 413) };
  try {
    const body = texto ? JSON.parse(texto) : {};
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('no es un objeto');
    return { body };
  } catch {
    return { respuesta: json({ error: 'JSON inválido' }, 400) };
  }
}

function enlacesBot(bot, codigo) {
  return {
    enlace: `https://t.me/${bot}?start=${codigo}`,
    enlace_grupo: `https://t.me/${bot}?startgroup=${codigo}`
  };
}

function usuarioBot(env) {
  const u = String(env.TELEGRAM_BOT_USERNAME || '').trim().replace(/^@/, '');
  return /^[A-Za-z0-9_]{5,32}$/.test(u) && !/REEMPLAZAR/i.test(u) ? u : null;   // un marcador sin reemplazar no sirve
}

// ── GET /api/config-publica ───────────────────────────────
async function configPublica(request, env) {
  const prod = esProduccion(env);
  let completa = prod;
  if (!completa) {
    try { completa = !!(await verifyRequest(request, env)); } catch { completa = false; }
  }
  const emp = await getEmpresa(env);
  const vehiculos = completa ? await vehiculosFlota(env) : [];
  const f = funciones(env);
  // Booleano sin datos: la instancia admite una sola empresa; con una ya inscrita no se invita a inscribirse
  let abierta = !prod && f.inscripcion;
  if (abierta) {
    try { abierta = !(await hayEmpresa(env)); } catch { /* sin tabla todavía: la inscripción dirá qué falta */ }
  }
  return json({
    ok: true,
    entorno: prod ? 'production' : String(env.ENVIRONMENT),
    // Fuera de producción, sin sesión no se entrega ni el nombre (puede ser el de una persona natural) ni el NIT
    empresa: { nombre: completa ? (emp.nombre || null) : null, nit: completa ? (emp.nit || null) : null },
    vehiculos,
    funciones: f,
    inscripcion_abierta: abierta,
    bot: { username: usuarioBot(env) },
    terminos: { version: versionTerminos(env) },
    completa
  });
}

// ── POST /api/admin/invitaciones ──────────────────────────
async function crearInvitacion(request, env, url) {
  if (!funciones(env).inscripcion) return json({ error: MSG_NO_ACTIVA }, 404);
  if (!(await igualSeguro(request.headers.get('x-admin-token') || '', env.ADMIN_SETUP_TOKEN || ''))) {
    return json({ error: 'Token de administrador inválido' }, 403);
  }
  const { body, respuesta } = await leerJson(request);
  if (respuesta) return respuesta;

  let dias = body.dias_validez == null ? 7 : Number(body.dias_validez);
  if (!Number.isInteger(dias) || dias < 1 || dias > 30) return json({ error: 'dias_validez debe ser un entero entre 1 y 30' }, 400);
  const nota = body.nota == null ? null : sinControl(String(body.nota)).slice(0, 200) || null;

  try {
    if (await hayEmpresa(env)) return json({ error: 'Esta instancia ya tiene una empresa inscrita' }, 409);
    if (await baseConVehiculosAjenos(env)) return json({ error: MSG_BASE_SUCIA }, 500);
    const codigo = nuevoCodigoInvitacion();
    const expira = fechaSql(Date.now() + dias * 86400000);
    await env.DB.prepare('INSERT INTO invitaciones (codigo_hash, nota, expira_en) VALUES (?, ?, ?)')
      .bind(await sha256Hex(codigo), nota, expira).run();
    const base = urlBase(env, null) || url.origin;
    // La base nace sin usuarios y sin webhook: se registra aquí para que el bot ya responda cuando el invitado
    // abra su enlace de Telegram. Si falla no se pierde la invitación: el resultado va en la respuesta.
    let webhook;
    try { webhook = await healWebhook(env); } catch (err) { webhook = { ok: false, error: 'excepcion' }; }
    const webhookOk = !!(webhook && webhook.ok);
    // El código va en el fragmento (#), no en la consulta, para que no quede en los registros del servidor
    return json({
      ok: true, codigo, enlace: `${base}/inscripcion.html#c=${codigo}`, expira_en: expira,
      webhook: webhookOk
        ? { ok: true }
        : { ok: false, motivo: (webhook && webhook.error) || 'telegram_rechazo',
            aviso: 'El webhook del bot NO quedó registrado. Revise WORKER_URL, TELEGRAM_BOT_TOKEN y TELEGRAM_WEBHOOK_SECRET y llame POST /api/telegram/heal con x-admin-token antes de enviar la invitación.' }
    }, 201);
  } catch (err) {
    console.error('[INSCRIPCION] crear invitación falló:', err && err.message);
    return json({ error: 'No se pudo crear la invitación. ¿Se aplicó schema-piloto.sql?' }, 500);
  }
}

// ── POST /api/inscripcion/validar ─────────────────────────
async function validarInvitacion(request, env) {
  if (!funciones(env).inscripcion) return json({ error: MSG_NO_ACTIVA }, 404);
  const { body, respuesta } = await leerJson(request);
  if (respuesta) return respuesta;
  if (!codigoBienFormado(body.codigo)) return json({ error: 'Código de invitación con formato inválido' }, 400);
  try {
    const inv = (await hayEmpresa(env)) ? null : await invitacionVigente(env, body.codigo);
    if (!inv) return invitacionRechazada(env, await hashIp(request), 'validar');
    return json({ ok: true, expira_en: inv.expira_en });
  } catch (err) {
    console.error('[INSCRIPCION] validar falló:', err && err.message);
    return json({ error: 'Error interno' }, 500);
  }
}

// ── POST /api/inscripcion ─────────────────────────────────
async function inscribir(request, env) {
  // (1) bandera
  const f = funciones(env);
  if (!f.inscripcion) return json({ error: MSG_NO_ACTIVA }, 404);

  const { body, respuesta } = await leerJson(request);
  if (respuesta) return respuesta;

  // (2) trampa para robots: respuesta de éxito falsa, sin crear nada
  if (body.sitio_web != null && String(body.sitio_web) !== '') return json({ ok: true }, 201);

  // (3) validación estricta de cada campo
  const v = validarInscripcion(body, versionTerminos(env));
  if (!v.ok) return json({ error: 'Revise los datos del formulario', campos: v.campos }, 400);
  const d = v.datos;

  let invHash = null;
  let reclamada = false;
  try {
    // (4) la invitación va PRIMERO: sin una vigente no se toca el esquema ni se revela nada de la instancia.
    // El límite de intentos (por IP) se aplica solo cuando falla, así nadie le cierra la puerta al invitado.
    const ipHash = await hashIp(request);
    const inv = await invitacionVigente(env, d.codigo);
    if (!inv) return invitacionRechazada(env, ipHash, 'inscripcion');
    invHash = inv.hash;

    // (5) columna que puede faltar en una base creada con los .sql viejos
    await asegurarEsquema(env);

    // (6) una sola empresa por instancia, y sobre una base sin vehículos de otra empresa
    if (await hayEmpresa(env)) return json({ error: 'Esta instancia ya tiene una empresa inscrita' }, 409);
    if (await baseConVehiculosAjenos(env)) {
      console.error('[INSCRIPCION] la tabla vehiculos ya tiene filas: se aplicó el esquema equivocado');
      return json({ error: 'Esta instancia no está lista para inscribir. Escríbale a quien le envió la invitación.' }, 500);
    }

    // No se dice si el correo ya existe: mensaje genérico
    const existe = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(d.correo).first();
    if (existe) {
      return json({ error: 'No se pudo completar la inscripción con estos datos. Escríbale a quien le envió la invitación.' }, 409);
    }

    const passwordHash = await hashPassword(d.password);

    // (7) reclamo atómico de la invitación: dos envíos simultáneos no pueden usarla a la vez
    const reclamo = await env.DB.prepare(
      "UPDATE invitaciones SET usada_en = datetime('now') WHERE codigo_hash = ? AND usada_en IS NULL AND expira_en > datetime('now')"
    ).bind(invHash).run();
    if (!(reclamo && reclamo.meta && reclamo.meta.changes === 1)) {
      await registrarFallo(env, ipHash, 'inscripcion');
      return json({ error: MSG_INVITACION }, 403);
    }
    reclamada = true;

    // Códigos de vinculación de Telegram (solo su hash va a D1)
    const bot = usuarioBot(env);
    const expiraVinculo = fechaSql(Date.now() + DIAS_VINCULO * 86400000);
    const vinculos = [];
    if (bot) {
      vinculos.push({
        rol: 'dueno', placa: d.placas.length === 1 ? d.placas[0] : null, nombre: d.empresa, codigo: nuevoCodigoVinculo()
      });
      for (const placa of d.placas) {
        vinculos.push({
          rol: 'conductor', placa,
          // El formulario pide un solo conductor: es el de la primera placa
          nombre: d.conductor && placa === d.placas[0] ? d.conductor.nombre : `Conductor ${etiquetaPlaca(placa)}`,
          codigo: nuevoCodigoVinculo()
        });
      }
    }

    // (8) todo en una transacción
    const ip = (request.headers.get('CF-Connecting-IP') || '').slice(0, 64) || null;
    const ua = (request.headers.get('User-Agent') || '').slice(0, 300) || null;
    const version = versionTerminos(env);
    const uid = '(SELECT id FROM users WHERE email = ?)';
    const stmts = [
      env.DB.prepare("INSERT INTO users (email, password_hash, nombre, rol) VALUES (?, ?, ?, 'admin')")
        .bind(d.correo, passwordHash, d.empresa),
      env.DB.prepare(
        `INSERT INTO config_empresa (id, nombre, documento_tipo, documento, correo, celular, conductor_nombre, conductor_celular, transportadoras, user_id)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ${uid})`
      ).bind(d.empresa, d.docTipo, d.documento, d.correo, d.celular,
        d.conductor ? d.conductor.nombre : null, d.conductor ? d.conductor.celular : null,
        JSON.stringify(d.transportadoras), d.correo),
      ...d.placas.map(p => env.DB.prepare('INSERT OR IGNORE INTO vehiculos (placa, nombre) VALUES (?, ?)').bind(p, etiquetaPlaca(p))),
      ...['terminos_piloto', 'datos_1581'].map(tipo => env.DB.prepare(
        `INSERT INTO consentimientos (sujeto, tipo, version_texto, user_id, nombre, documento, ip, user_agent)
         VALUES ('titular', ?, ?, ${uid}, ?, ?, ?, ?)`
      ).bind(tipo, version, d.correo, d.empresa, d.documento, ip, ua)),
      ...(await Promise.all(vinculos.map(async vn => env.DB.prepare(
        `INSERT INTO telegram_vinculos (codigo_hash, rol, placa, nombre, creado_por, expira_en) VALUES (?, ?, ?, ?, ${uid}, ?)`
      ).bind(await sha256Hex(vn.codigo), vn.rol, vn.placa, vn.nombre, d.correo, expiraVinculo)))),
      env.DB.prepare(`UPDATE invitaciones SET usada_por = ${uid} WHERE codigo_hash = ?`).bind(d.correo, invHash)
    ];
    await env.DB.batch(stmts);
    invalidarEmpresa();

    // (10) sesión: temporal si hay verificación en dos pasos (sigue con setup-2fa / verify-2fa), completa si no
    const user = await env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(d.correo).first();
    let sesion = { token: null, expires_at: null };
    try {
      sesion = f.auth_2fa
        ? await createSession(env.DB, user.id, 'temp', TTL_SESION_INSCRIPCION_MS)
        : await createSession(env.DB, user.id, 'full');
    } catch (err) {
      // La inscripción ya quedó hecha: sin sesión el dueño entra por login.html
      console.error('[INSCRIPCION] no pude crear la sesión:', err && err.message);
    }

    return json({
      ok: true,
      user: { email: d.correo, nombre: d.empresa, rol: 'admin' },
      empresa: { nombre: d.empresa },
      vehiculos: d.placas.map(p => ({ placa: p, nombre: etiquetaPlaca(p) })),
      auth: {
        requiere_2fa: f.auth_2fa,
        temp_token: f.auth_2fa ? sesion.token : null,
        session_token: f.auth_2fa ? null : sesion.token,
        expires_at: sesion.expires_at
      },
      telegram: {
        bot_username: bot,
        expira_en: expiraVinculo,
        vinculos: vinculos.map(vn => ({ rol: vn.rol, placa: vn.placa, nombre: vn.nombre, ...enlacesBot(bot, vn.codigo) }))
      },
      siguiente: { login_url: '/login.html', dashboard_url: '/dashboard.html' }
    }, 201);
  } catch (err) {
    console.error('[INSCRIPCION] falló:', err && err.message);
    // (9) si la invitación ya estaba reclamada y lo demás no quedó guardado, se libera para no dejar bloqueado al invitado
    if (reclamada && invHash) {
      try {
        if (!(await hayEmpresa(env))) {
          await env.DB.prepare('UPDATE invitaciones SET usada_en = NULL, usada_por = NULL WHERE codigo_hash = ?').bind(invHash).run();
        }
      } catch (e2) {
        console.error('[INSCRIPCION] no pude liberar la invitación:', e2 && e2.message);
      }
    }
    return json({ error: 'Error interno. Intente de nuevo en un momento.' }, 500);
  }
}

// ── POST /api/vinculacion-telegram ────────────────────────
async function nuevoVinculo(request, env, authUser) {
  if (!authUser) return json({ error: 'Unauthorized' }, 401);
  if (authUser.rol !== 'admin') return json({ error: 'Solo un administrador puede generar enlaces de vinculación' }, 403);
  const { body, respuesta } = await leerJson(request);
  if (respuesta) return respuesta;

  const rol = body.rol;
  if (rol !== 'dueno' && rol !== 'conductor') return json({ error: 'rol debe ser dueno o conductor', campos: { rol: 'Valor inválido' } }, 400);
  let placa = null;
  if (body.placa != null && body.placa !== '') {
    placa = normalizarPlaca(body.placa);
    if (!placa) return json({ error: 'Placa inválida', campos: { placa: 'Debe tener la forma AAA123' } }, 400);
  } else if (rol === 'conductor') {
    return json({ error: 'La placa es obligatoria para un conductor', campos: { placa: 'Obligatoria' } }, 400);
  }
  let nombre = null;
  if (body.nombre != null && body.nombre !== '') {
    if (typeof body.nombre !== 'string' || sinControl(body.nombre).length > 80) {
      return json({ error: 'Nombre inválido', campos: { nombre: 'Máximo 80 caracteres' } }, 400);
    }
    nombre = sinControl(body.nombre) || null;
  }

  const bot = usuarioBot(env);
  if (!bot) return json({ error: 'Falta configurar TELEGRAM_BOT_USERNAME' }, 503);

  if (placa) {
    let veh;
    try { veh = await env.DB.prepare('SELECT placa FROM vehiculos WHERE placa = ?').bind(placa).first(); }
    catch { return json({ error: 'La vinculación por enlace no está disponible en esta instancia' }, 503); }
    if (!veh) return json({ error: 'La placa no existe en los vehículos de esta instancia' }, 404);
  }

  try {
    const codigo = nuevoCodigoVinculo();
    const expira = fechaSql(Date.now() + DIAS_VINCULO * 86400000);
    if (!nombre) {
      // El enlace nuevo reemplaza al anterior sin usar de ese rol y placa: conserva el nombre que traía
      // (p. ej. el del conductor escrito en la inscripción)
      const previo = await env.DB.prepare(
        'SELECT nombre FROM telegram_vinculos WHERE usado_en IS NULL AND rol = ? AND placa IS ? ORDER BY creado_en DESC LIMIT 1'
      ).bind(rol, placa).first();
      if (previo && previo.nombre) nombre = sinControl(String(previo.nombre)).slice(0, 80) || null;
    }
    if (!nombre) nombre = rol === 'dueno' ? (authUser.nombre || null) : `Conductor ${etiquetaPlaca(placa)}`;
    await env.DB.batch([
      // Un solo enlace vigente por rol y placa: los anteriores sin usar dejan de servir
      env.DB.prepare('DELETE FROM telegram_vinculos WHERE usado_en IS NULL AND rol = ? AND placa IS ?').bind(rol, placa),
      env.DB.prepare('INSERT INTO telegram_vinculos (codigo_hash, rol, placa, nombre, creado_por, expira_en) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(await sha256Hex(codigo), rol, placa, nombre, authUser.id, expira)
    ]);
    return json({ ok: true, vinculo: { rol, placa, nombre, ...enlacesBot(bot, codigo), expira_en: expira } }, 201);
  } catch (err) {
    console.error('[VINCULO] falló:', err && err.message);
    return json({ error: 'La vinculación por enlace no está disponible en esta instancia' }, 503);
  }
}

// ── GET /api/telegram/chats ───────────────────────────────
async function listarChats(env, authUser) {
  if (!authUser) return json({ error: 'Unauthorized' }, 401);
  if (authUser.rol !== 'admin') return json({ error: 'Solo un administrador puede ver los chats vinculados' }, 403);
  try {
    const [chats, pendientes] = await Promise.all([
      env.DB.prepare(
        'SELECT chat_id, rol, placa, nombre, vinculado_en, activo, acepto_datos_en FROM telegram_chats ORDER BY activo DESC, vinculado_en DESC'
      ).all(),
      // Nunca se devuelve el código ni su hash
      env.DB.prepare(
        "SELECT rol, placa, nombre, expira_en FROM telegram_vinculos WHERE usado_en IS NULL AND expira_en > datetime('now') ORDER BY creado_en DESC"
      ).all()
    ]);
    return json({ ok: true, chats: chats.results || [], pendientes: pendientes.results || [] });
  } catch {
    return json({ error: 'La vinculación por enlace no está disponible en esta instancia' }, 503);
  }
}

// ── DELETE /api/telegram/chats/:chat_id ───────────────────
async function revocarChat(env, authUser, chatId) {
  if (!authUser) return json({ error: 'Unauthorized' }, 401);
  if (authUser.rol !== 'admin') return json({ error: 'Solo un administrador puede revocar un chat' }, 403);
  if (!/^-?\d{1,20}$/.test(chatId)) return json({ error: 'chat_id inválido' }, 400);
  try {
    const r = await env.DB.prepare('UPDATE telegram_chats SET activo = 0 WHERE chat_id = ?').bind(chatId).run();
    if (!(r && r.meta && r.meta.changes > 0)) return json({ error: 'Chat no encontrado' }, 404);
    return json({ ok: true, chat_id: chatId, activo: 0 });
  } catch {
    return json({ error: 'La vinculación por enlace no está disponible en esta instancia' }, 503);
  }
}

// ── Primeros pasos (guía del tablero) ─────────────────────
const GUIA_VACIA = { visible: false, completados: 0, total: 0, pasos: [] };
const SIN_ACCION = { tipo: 'ninguna', texto: '' };

// Arma la respuesta de GET /api/primeros-pasos. Pura (exportada para las pruebas).
// estado = { dueno, conductor, conductorSinAceptar, viajes, gastos, extractos, oculta } (booleanos), más:
//          conductorPropio (el dueño marcó que él mismo maneja) y enlaceDueno / enlaceConductor
//          (fecha de vencimiento 'YYYY-MM-DD HH:MM:SS' en UTC del enlace sin usar de ese rol, o null)
// ctx    = { bot: usuario del bot o null, placas: [placas de la flota] }
// En las acciones 'vinculo_telegram' van además rol y placa (la placa solo si la flota tiene una): es lo que el
// tablero le manda a POST /api/vinculacion-telegram; con reemplaza: true ya hay un enlace sin usar y pedir otro lo anula.
// Algunos pasos traen además accion_secundaria ({ tipo: 'marcar' | 'desmarcar', texto }): una salida que no es la principal.
export function armarPasos(estado, ctx = {}) {
  const e = estado || {};
  const bot = ctx.bot || null;
  const placas = Array.isArray(ctx.placas) ? ctx.placas : [];
  const unica = placas.length === 1 ? placas[0] : null;
  const abrirBot = bot ? { tipo: 'enlace', texto: 'Abrir Telegram', url: `https://t.me/${bot}` } : SIN_ACCION;
  const vinculo = (texto, rol, reemplaza) => (bot
    ? { tipo: 'vinculo_telegram', texto, rol, placa: unica, ...(reemplaza ? { reemplaza: true } : {}) }
    : SIN_ACCION);
  const yaHayEnlace = (vence, quien) => {
    const dia = diaColombia(vence);
    return `Ya tiene un enlace sin usar${quien}${dia ? ' (vence el ' + dia + ')' : ''}. Si lo perdió, pida otro: el anterior deja de servir.`;
  };
  const conductorHecho = !!e.conductor || !!e.conductorPropio;
  // Sin el Telegram del dueño, "Abrir Telegram" lo lleva a un chat que todavía no puede recibir fotos
  const sinTelegram = !e.dueno;

  const pasos = [
    {
      id: 'telegram_dueno',
      titulo: 'Conecte su Telegram',
      detalle: e.dueno
        ? 'Su Telegram ya está conectado. Por ahí manda las fotos y le avisamos lo que leímos.'
        : (e.enlaceDueno
          ? yaHayEnlace(e.enlaceDueno, '')
          : 'Abra el enlace en su celular y toque Iniciar. Por ahí manda las fotos y le avisamos lo que leímos.'),
      hecho: !!e.dueno,
      accion: e.dueno ? SIN_ACCION : (e.enlaceDueno ? vinculo('Pedir otro enlace', 'dueno', true) : vinculo('Conectar mi Telegram', 'dueno'))
    },
    {
      id: 'conductor',
      titulo: 'Conecte a su conductor',
      detalle: e.conductor
        ? (e.conductorSinAceptar
          ? 'Su conductor ya abrió el enlace. Falta que responda /acepto en el chat para poder mandar fotos.'
          : 'Su conductor ya está conectado y puede mandar las fotos desde la carretera.')
        : (e.conductorPropio
          ? 'Usted mismo maneja la mula: las fotos las manda usted. Si después tiene conductor, saque su enlace en "Vehículos / Telegram".'
          : (e.enlaceConductor
            ? yaHayEnlace(e.enlaceConductor, ' para su conductor')
            : 'Pida el enlace y mándeselo por WhatsApp. Él lo abre, acepta el aviso de datos y ya puede mandar fotos.')),
      hecho: conductorHecho,
      accion: conductorHecho ? SIN_ACCION
        : (e.enlaceConductor ? vinculo('Pedir otro enlace', 'conductor', true) : vinculo('Crear enlace para el conductor', 'conductor')),
      ...(e.conductor ? {} : {
        accion_secundaria: e.conductorPropio
          ? { tipo: 'desmarcar', texto: 'Sí tengo conductor' }
          : { tipo: 'marcar', texto: 'Yo mismo manejo la mula' }
      })
    },
    {
      id: 'primer_manifiesto',
      titulo: 'Mande el primer manifiesto',
      detalle: e.viajes
        ? 'Ya llegó el primer manifiesto. Cada uno queda como un viaje con su flete, su anticipo y su saldo.'
        : (sinTelegram
          ? 'Primero conecte su Telegram (paso 1). Después manda por ahí la foto del manifiesto y sabemos qué transportadora le debe y cuánto.'
          : 'Tómele una foto completa y derecha, con buena luz, y mándela por Telegram. Con eso sabemos qué transportadora le debe y cuánto.'),
      hecho: !!e.viajes,
      accion: e.viajes || sinTelegram ? SIN_ACCION : abrirBot
    },
    {
      id: 'primer_gasto',
      titulo: 'Mande el primer recibo',
      detalle: e.gastos
        ? 'Ya llegó el primer recibo. Siga mandando uno por foto.'
        : (sinTelegram
          ? 'Primero conecte su Telegram (paso 1). Después manda una foto por cada recibo y le decimos cuánto le deja cada mula.'
          : 'Una foto por cada recibo de ACPM, peaje o gasto. Así le decimos cuánto le deja cada mula.'),
      hecho: !!e.gastos,
      accion: e.gastos || sinTelegram ? SIN_ACCION : abrirBot
    },
    {
      id: 'extractos',
      titulo: 'Envíe los extractos del banco',
      detalle: e.extractos
        ? 'Listo. Con los extractos revisamos qué viajes ya le pagaron y cuáles le deben.'
        : 'Envíe los extractos de la cuenta donde le pagan a quien le envió la invitación. Con ellos revisamos qué viajes ya le pagaron. Cuando los envíe, márquelo aquí.',
      hecho: !!e.extractos,
      accion: e.extractos ? SIN_ACCION : { tipo: 'marcar', texto: 'Ya los envié' },
      ...(e.extractos ? { accion_secundaria: { tipo: 'desmarcar', texto: 'Todavía no los he enviado' } } : {})
    }
  ];
  return {
    visible: !e.oculta,
    completados: pasos.filter(p => p.hecho).length,
    total: pasos.length,
    pasos
  };
}

// 'YYYY-MM-DD HH:MM:SS' en UTC → "19 de noviembre" en hora de Colombia (UTC-5 todo el año); null si no es una fecha
const MESES_GUIA = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
function diaColombia(fechaUtc) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(fechaUtc || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 5 * 3600000);
  return isNaN(d) ? null : `${d.getUTCDate()} de ${MESES_GUIA[d.getUTCMonth()]}`;
}

// { dueno, conductor }: vencimiento del enlace de Telegram sin usar y vigente de cada rol, o null
async function enlacesSinUsar(env) {
  const out = { dueno: null, conductor: null };
  try {
    const r = await env.DB.prepare(
      "SELECT rol, MAX(expira_en) AS expira FROM telegram_vinculos WHERE usado_en IS NULL AND expira_en > datetime('now') GROUP BY rol"
    ).all();
    for (const f of (r && r.results) || []) if (f.rol === 'dueno' || f.rol === 'conductor') out[f.rol] = f.expira || null;
  } catch { /* sin tabla: no hay enlaces */ }
  return out;
}

// true/false; si la tabla no existe o la consulta falla, false (la guía no puede tumbar el tablero)
async function hayFilas(env, sql) {
  try { return !!(await env.DB.prepare(sql).first()); } catch { return false; }
}

// { oculta, extractos, conductorPropio } desde config_empresa; sin empresa inscrita o sin tabla, todo en false
async function estadoGuia(env) {
  const nada = { oculta: false, extractos: false, conductorPropio: false };
  try {
    if (!(await asegurarEsquemaGuia(env))) return nada;
    const row = await env.DB.prepare('SELECT guia_oculta, extractos_marcado_en, conductor_propio_en FROM config_empresa WHERE id = 1').first();
    return {
      oculta: !!(row && row.guia_oculta), extractos: !!(row && row.extractos_marcado_en),
      conductorPropio: !!(row && row.conductor_propio_en)
    };
  } catch (err) {
    console.error('[GUIA] no pude leer el estado:', err && err.message);
    return nada;
  }
}

// ── GET /api/primeros-pasos ───────────────────────────────
async function primerosPasos(env, authUser) {
  if (!authUser) return json({ error: 'Unauthorized' }, 401);
  // Producción no tiene guía: se responde vacío sin consultar ninguna tabla
  if (esProduccion(env)) return json(GUIA_VACIA);
  const [guia, enlaces, dueno, conductor, conductorAcepto, viajes, gastos, placas] = await Promise.all([
    estadoGuia(env),
    enlacesSinUsar(env),
    hayFilas(env, "SELECT 1 FROM telegram_chats WHERE activo = 1 AND rol = 'dueno' LIMIT 1"),
    hayFilas(env, "SELECT 1 FROM telegram_chats WHERE activo = 1 AND rol = 'conductor' LIMIT 1"),
    hayFilas(env, "SELECT 1 FROM telegram_chats WHERE activo = 1 AND rol = 'conductor' AND acepto_datos_en IS NOT NULL LIMIT 1"),
    hayFilas(env, 'SELECT 1 FROM viajes LIMIT 1'),
    hayFilas(env, 'SELECT 1 FROM gastos LIMIT 1'),
    placasFlota(env).catch(() => [])
  ]);
  return json(armarPasos(
    {
      dueno, conductor, conductorSinAceptar: conductor && !conductorAcepto, viajes, gastos,
      extractos: guia.extractos, oculta: guia.oculta, conductorPropio: guia.conductorPropio,
      enlaceDueno: enlaces.dueno, enlaceConductor: enlaces.conductor
    },
    { bot: usuarioBot(env), placas }
  ));
}

// ── POST /api/primeros-pasos ──────────────────────────────
// { accion: 'marcar', id: 'extractos' } | { accion: 'ocultar' } | { accion: 'mostrar' }
// Además: { accion: 'marcar', id: 'conductor' } ("yo mismo manejo la mula") y { accion: 'desmarcar', id: 'extractos' | 'conductor' }
async function accionPrimerosPasos(request, env, authUser) {
  if (!authUser) return json({ error: 'Unauthorized' }, 401);
  // En producción no hay guía: no se escribe nada
  if (esProduccion(env)) return json({ error: 'Not found' }, 404);
  if (authUser.rol !== 'admin') return json({ error: 'Solo el dueño puede cambiar la guía' }, 403);
  const { body, respuesta } = await leerJson(request);
  if (respuesta) return respuesta;

  let sql;
  if (body.accion === 'marcar' || body.accion === 'desmarcar') {
    // Los demás pasos se cumplen solos (dependen de lo que ya llegó): solo estos dos los marca el dueño.
    // El nombre de la columna sale de esta lista fija, nunca de la petición.
    const columna = body.id === 'extractos' ? 'extractos_marcado_en' : body.id === 'conductor' ? 'conductor_propio_en' : null;
    if (!columna) return json({ error: 'Ese paso no se marca a mano', campos: { id: 'Solo extractos o conductor' } }, 400);
    const valor = body.accion === 'marcar' ? `COALESCE(${columna}, datetime('now'))` : 'NULL';
    sql = `UPDATE config_empresa SET ${columna} = ${valor}, actualizado_en = datetime('now') WHERE id = 1`;
  } else if (body.accion === 'ocultar') {
    sql = "UPDATE config_empresa SET guia_oculta = 1, actualizado_en = datetime('now') WHERE id = 1";
  } else if (body.accion === 'mostrar') {
    sql = "UPDATE config_empresa SET guia_oculta = 0, actualizado_en = datetime('now') WHERE id = 1";
  } else {
    return json({ error: 'accion debe ser marcar, desmarcar, ocultar o mostrar', campos: { accion: 'Valor inválido' } }, 400);
  }

  try {
    if (!(await asegurarEsquemaGuia(env))) return json({ error: 'La guía no está disponible en esta instancia' }, 503);
    const r = await env.DB.prepare(sql).run();
    if (!(r && r.meta && r.meta.changes === 1)) return json({ error: 'Esta instancia todavía no tiene una empresa inscrita' }, 409);
    return json({ ok: true });
  } catch (err) {
    console.error('[GUIA] no pude guardar:', err && err.message);
    return json({ error: 'No se pudo guardar. Intente de nuevo en un momento.' }, 500);
  }
}

function soloOrigenPropio(respuesta, url) {
  respuesta.headers.set('Access-Control-Allow-Origin', url.origin);
  respuesta.headers.append('Vary', 'Origin');
  return respuesta;
}

// ── Enrutador ─────────────────────────────────────────────
// Devuelve una Response si la ruta es de este módulo, o null para que worker.js siga con las suyas.
export async function rutasInscripcion(request, env, url, authUser) {
  const m = request.method;
  const p = url.pathname;
  if (m === 'GET' && p === '/api/config-publica') return configPublica(request, env);
  // Estas tres solo existen donde el Worker sirve también los HTML (un solo origen): no se abren a otros orígenes
  if (m === 'POST' && p === '/api/admin/invitaciones') return soloOrigenPropio(await crearInvitacion(request, env, url), url);
  if (m === 'POST' && p === '/api/inscripcion/validar') return soloOrigenPropio(await validarInvitacion(request, env), url);
  if (m === 'POST' && p === '/api/inscripcion') return soloOrigenPropio(await inscribir(request, env), url);
  if (m === 'POST' && p === '/api/vinculacion-telegram') return nuevoVinculo(request, env, authUser);
  if (m === 'GET' && p === '/api/telegram/chats') return listarChats(env, authUser);
  if (m === 'GET' && p === '/api/primeros-pasos') return primerosPasos(env, authUser);
  if (m === 'POST' && p === '/api/primeros-pasos') return accionPrimerosPasos(request, env, authUser);
  if (m === 'DELETE' && p.startsWith('/api/telegram/chats/')) {
    let chatId = p.slice('/api/telegram/chats/'.length);
    try { chatId = decodeURIComponent(chatId); } catch { /* se valida abajo */ }
    return revocarChat(env, authUser, chatId);
  }
  return null;
}
