// ============================================================
// Configuración por instancia (empresa, placas y funciones)
// Todo lo nuevo se enciende con variables que SOLO existen en un entorno
// distinto al de producción (p. ej. [env.piloto] en wrangler.toml).
// Sin esas variables cada función devuelve lo mismo que estaba fijo en el código.
// ============================================================

// Flota del entorno de producción (valor por defecto cuando PLACAS_FUENTE no es "d1")
export const PLACAS_DEFECTO = ['STT115', 'STT121', 'UPO707'];

export const TERMINOS_VERSION_DEFECTO = 'piloto-v1';

// Funciones que se pueden apagar con FEATURES_OFF (lista separada por comas).
// En producción todas están encendidas salvo las que nombre FEATURES_OFF (como siempre).
// Fuera de producción es al revés: todas apagadas salvo las que nombre FEATURES_ON; un error de digitación
// en FEATURES_OFF no puede encender nada.
const FUNCIONES_APAGABLES = [
  'facturacion', 'correo_terceros', 'pagos_finandina', 'correo_alertas',
  'recurrentes', 'pdf_fiscal', 'captura_publica'
];

// Sin ENVIRONMENT se asume producción (las variables no se heredan entre entornos de wrangler), salvo que la instancia
// tenga encendido algo que solo existe fuera de producción (INSCRIPCION="on" o PLACAS_FUENTE="d1").
export function esProduccion(env) {
  if (!env) return true;
  if (env.ENVIRONMENT) return env.ENVIRONMENT === 'production';
  return env.INSCRIPCION !== 'on' && env.PLACAS_FUENTE !== 'd1';
}

export function versionTerminos(env) {
  return String((env && env.TERMINOS_VERSION) || TERMINOS_VERSION_DEFECTO);
}

// { facturacion, correo_terceros, pagos_finandina, correo_alertas, recurrentes, pdf_fiscal, captura_publica, inscripcion, auth_2fa }
export function funciones(env) {
  const lista = v => new Set(String(v || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const apagadas = lista(env && env.FEATURES_OFF);
  const encendidas = esProduccion(env) ? null : lista(env && env.FEATURES_ON);
  const out = {};
  for (const f of FUNCIONES_APAGABLES) out[f] = !apagadas.has(f) && (!encendidas || encendidas.has(f));
  out.inscripcion = !!env && env.INSCRIPCION === 'on';
  out.auth_2fa = !!env && env.AUTH_2FA === 'on';
  return out;
}

export function funcionActiva(env, nombre) {
  return funciones(env)[nombre] === true;
}

// Función a la que pertenece una ruta (para el guardia de worker.js), o null si la ruta no depende de ninguna.
// 'recurrentes' no está aquí: esa ruta responde vacío con la forma de siempre en vez de 404.
export function funcionDeRuta(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/api/aliaddo/') || p === '/api/terceros' || p.startsWith('/api/terceros/')
      || /^\/api\/viajes\/\d+\/(facturar|datos-factura)$/.test(p)
      || /^\/api\/gastos\/(\d+\/soporte|soporte-candidatos|soportes-masivo)$/.test(p)) return 'facturacion';
  if (p.startsWith('/api/pago-masivo/') || p === '/api/extraer-certificado-bancario') return 'pagos_finandina';
  if (p === '/api/reporte') return 'pdf_fiscal';
  return null;
}

// ── Placas ────────────────────────────────────────────────
// Devuelve la placa normalizada (AAA123) o null si no tiene forma de placa colombiana de vehículo de carga
export function normalizarPlaca(s) {
  const p = String(s == null ? '' : s).toUpperCase().replace(/[\s\-]/g, '');
  return /^[A-Z]{3}\d{3}$/.test(p) ? p : null;
}

export function etiquetaPlaca(placa) {
  const p = String(placa || '');
  return /^[A-Z]{3}\d{3}$/.test(p) ? `${p.slice(0, 3)} ${p.slice(3)}` : p;
}

function placasDeVariable(env) {
  const vistas = new Set();
  for (const s of String((env && env.FLOTA_PLACAS) || '').split(',')) {
    const p = normalizarPlaca(s);
    if (p) vistas.add(p);
  }
  return [...vistas];
}

export function placasDesdeD1(env) {
  return !!env && env.PLACAS_FUENTE === 'd1';
}

// [{ placa, nombre }] de la flota de esta instancia.
// Sin PLACAS_FUENTE="d1": la lista fija de siempre. Con "d1": tabla vehiculos → FLOTA_PLACAS → [].
// Fuera de producción nunca cae a las placas por defecto.
export async function vehiculosFlota(env) {
  if (!placasDesdeD1(env)) return PLACAS_DEFECTO.map(placa => ({ placa, nombre: etiquetaPlaca(placa) }));
  try {
    const r = await env.DB.prepare('SELECT placa, nombre FROM vehiculos WHERE activo = 1 ORDER BY placa').all();
    const filas = (r && r.results) || [];
    if (filas.length) return filas.map(f => ({ placa: f.placa, nombre: f.nombre || etiquetaPlaca(f.placa) }));
  } catch { /* tabla ausente o base no disponible: se intenta la variable */ }
  return placasDeVariable(env).map(placa => ({ placa, nombre: etiquetaPlaca(placa) }));
}

export async function placasFlota(env) {
  if (!placasDesdeD1(env)) return PLACAS_DEFECTO;
  return (await vehiculosFlota(env)).map(v => v.placa);
}

// Opciones para los agentes de OCR. Sin PLACAS_FUENTE="d1" devuelve {} y los agentes usan su lista y sus textos
// de siempre (ni un carácter distinto); con "d1" devuelve { placas } (puede ser una lista vacía).
export async function opcionesPlacas(env) {
  if (!placasDesdeD1(env)) return {};
  return { placas: await placasFlota(env) };
}

// ── Empresa ───────────────────────────────────────────────
let cacheEmpresa = null;   // { valor, hasta } por isolate
const CACHE_EMPRESA_MS = 60000;

export function invalidarEmpresa() { cacheEmpresa = null; }

// { nombre, nit, correo, origen: 'd1' | 'env' }
// En producción la tabla config_empresa puede no existir: el fallo se traga y se responde con las variables de siempre.
export async function getEmpresa(env) {
  if (cacheEmpresa && cacheEmpresa.hasta > Date.now()) return cacheEmpresa.valor;
  let valor = null;
  try {
    const row = await env.DB.prepare('SELECT nombre, documento, correo FROM config_empresa WHERE id = 1').first();
    if (row) valor = { nombre: row.nombre || null, nit: row.documento || null, correo: row.correo || null, origen: 'd1' };
  } catch { /* sin tabla */ }
  if (!valor) {
    valor = {
      nombre: (env && env.EMISOR_NOMBRE) || null,
      nit: (env && env.EMISOR_NIT) || null,
      correo: (env && env.ALERT_EMAIL_TO) || null,
      origen: 'env'
    };
  }
  cacheEmpresa = { valor, hasta: Date.now() + CACHE_EMPRESA_MS };
  return valor;
}

// Correo al que van los avisos internos (gasto registrado, alerta diaria).
// Producción: igual que siempre. Fuera de producción: null si correo_alertas está apagada; si no, ALERT_EMAIL_TO o el
// correo de la empresa inscrita; nunca un correo fijo del código.
export async function destinatarioAlertas(env) {
  if (esProduccion(env)) return env.ALERT_EMAIL_TO || 'david@davidduque.com';
  if (!funcionActiva(env, 'correo_alertas')) return null;
  if (env.ALERT_EMAIL_TO) return env.ALERT_EMAIL_TO;
  const emp = await getEmpresa(env);
  return emp.correo || null;
}

// URL pública de esta instancia (webhook de Telegram y enlaces). Solo producción tiene respaldo fijo.
export function urlBase(env, respaldoProduccion) {
  // Un marcador REEMPLAZAR_... sin llenar no es una URL: se trata como si faltara
  if (env && env.WORKER_URL && !/REEMPLAZAR/i.test(env.WORKER_URL)) return String(env.WORKER_URL).replace(/\/+$/, '');
  return esProduccion(env) ? respaldoProduccion : null;
}

// ── Esquema ───────────────────────────────────────────────
// SQLite no tiene ADD COLUMN IF NOT EXISTS: la única columna que puede faltar en una base creada con los .sql
// viejos (vehiculos.telegram_chat_id) se agrega aquí tras revisar PRAGMA table_info. Solo lo llama inscripcion.js.
export async function asegurarEsquema(env) {
  const r = await env.DB.prepare('PRAGMA table_info(vehiculos)').all();
  const cols = ((r && r.results) || []).map(c => c.name);
  if (!cols.length) throw new Error('Falta la tabla vehiculos: aplique schema-base-piloto.sql');
  if (!cols.includes('telegram_chat_id')) {
    await env.DB.prepare('ALTER TABLE vehiculos ADD COLUMN telegram_chat_id TEXT').run();
  }
  await asegurarEsquemaGuia(env);
}

// Columnas de la guía de primeros pasos en config_empresa (una base creada antes de que existieran no las trae).
// Se revisa una vez por isolate. Nunca se llama en producción. Devuelve false si la tabla no existe.
const COLUMNAS_GUIA = [
  ['guia_oculta', 'INTEGER NOT NULL DEFAULT 0'],   // 1 = el dueño ocultó la guía
  ['extractos_marcado_en', 'TEXT'],                // fecha en que el dueño marcó "ya envié los extractos"
  ['conductor_propio_en', 'TEXT']                  // fecha en que el dueño marcó "yo mismo manejo la mula"
];
let esquemaGuiaListo = false;
export async function asegurarEsquemaGuia(env) {
  if (esquemaGuiaListo) return true;
  const r = await env.DB.prepare('PRAGMA table_info(config_empresa)').all();
  const cols = ((r && r.results) || []).map(c => c.name);
  if (!cols.length) return false;
  for (const [nombre, tipo] of COLUMNAS_GUIA) {
    if (cols.includes(nombre)) continue;
    try {
      await env.DB.prepare(`ALTER TABLE config_empresa ADD COLUMN ${nombre} ${tipo}`).run();
    } catch (err) {
      // Otra petición la agregó al mismo tiempo: no es un error
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  esquemaGuiaListo = true;
  return true;
}

// Texto de "a quién escribirle" para las ayudas. CONTACTO_SOPORTE es opcional (se llena en la máquina del dueño,
// nunca en el repositorio); sin ella no se nombra a nadie.
export function contactoSoporte(env) {
  const c = String((env && env.CONTACTO_SOPORTE) || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 80);
  return c && !/REEMPLAZAR/i.test(c) ? c : null;
}
