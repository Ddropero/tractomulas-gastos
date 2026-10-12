// ============================================================
// Envío de la factura electrónica al cliente (adquiriente) por correo, en el formato DIAN:
// - UN solo adjunto: el ZIP oficial que genera Aliaddo (AttachedDocument XML + PDF).
// - Asunto: "NIT facturador;Nombre facturador;Número documento;01;Nombre comercial".
// Sale por Resend desde el dominio propio porque el token de API de Aliaddo no puede pedirle
// a Aliaddo que lo envíe. El ZIP vive en un bucket privado: Aliaddo entrega una URL firmada
// temporal (sin login) en attachments/signUrl — la misma que usa "Exportar ZIP" en la web.
// ============================================================

const ZIP_RE = /^https:\/\/storage\.googleapis\.com\/aliaddo-tenant-sales\/invoices\/\d+\/[\w.-]+\.zip$/;
const FIRMADA_PREFIX = 'https://storage.googleapis.com/aliaddo-tenant-sales/';
const MAX_ZIP = 2 * 1024 * 1024; // límite DIAN para el adjunto

// URL del ZIP oficial: la que dé Aliaddo o, si solo hay la del PDF (firmada), la misma ruta con .zip
export function zipDesdeUrls(urlZip, urlPdf) {
  for (const u of [urlZip, urlPdf]) {
    if (!u) continue;
    const z = String(u).split('?')[0].replace(/\.pdf$/i, '.zip');
    if (ZIP_RE.test(z)) return z;
  }
  return null;
}

export async function urlFirmadaAliaddo(u, fetchFn = fetch) {
  const r = await fetchFn('https://app.aliaddo.net/attachments/signUrl?url=' + encodeURIComponent(u) + '&redirect=false');
  if (!r.ok) return null;
  const t = await r.text();
  let s; try { s = JSON.parse(t); } catch { s = t.trim(); }
  return typeof s === 'string' && s.startsWith(FIRMADA_PREFIX) ? s : null;
}

const sinPuntoYComa = (s) => String(s == null ? '' : s).replace(/[;\r\n]+/g, ' ').trim();

export function asuntoDian({ emisorNit, emisorNombre, numero, comercial }) {
  const nit = String(emisorNit || '').split('-')[0].replace(/\D/g, '');
  return [nit, sinPuntoYComa(emisorNombre), sinPuntoYComa(numero), '01', sinPuntoYComa(comercial || emisorNombre)].join(';');
}

export function correosValidos(lista) {
  const out = [];
  for (const e of Array.isArray(lista) ? lista : []) {
    const c = String(e || '').trim().toLowerCase();
    if (/^[^@\s;,<>]+@[^@\s;,<>]+\.[^@\s;,<>]+$/.test(c) && !out.includes(c)) out.push(c);
  }
  return out.slice(0, 5);
}

// Lee el XML (AttachedDocument) del ZIP y devuelve su cbc:ParentDocumentID = número de la factura.
// Así se garantiza que el ZIP adjunto es de la factura del asunto. null si no se puede leer.
async function xmlDelZip(buf) {
  const u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) return null;
  const n = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  for (let k = 0; k < n && p + 46 <= u8.length; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) return null;
    const metodo = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const ln = dv.getUint16(p + 28, true), le = dv.getUint16(p + 30, true), lc = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
    const nombre = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + ln));
    p += 46 + ln + le + lc;
    if (!/\.xml$/i.test(nombre)) continue;
    if (off + 30 > u8.length || dv.getUint32(off, true) !== 0x04034b50) return null;
    const ini = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const datos = u8.subarray(ini, ini + csize);
    if (metodo === 0) return new TextDecoder().decode(datos);
    if (metodo === 8) return await new Response(new Blob([datos]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
    return null;
  }
  return null;
}

export async function numeroEnZip(buf) {
  try {
    const xml = await xmlDelZip(buf);
    const m = xml && xml.match(/<cbc:ParentDocumentID>\s*([^<\s]+)\s*<\/cbc:ParentDocumentID>/);
    return m ? m[1] : null;
  } catch { return null; }
}

// El número del ZIP debe ser el de la factura (admite que el del ZIP traiga prefijo alfabético: FE513 ~ 513)
function mismoNumero(delZip, numero) {
  const z = String(delZip || ''), n = String(numero || '');
  if (!z || !n) return false;
  return z === n || (z.endsWith(n) && /^[A-Za-z]+$/.test(z.slice(0, z.length - n.length)));
}

function b64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const cop = (v) => '$' + Math.round(Number(v) || 0).toLocaleString('es-CO');

// datos: { numero, urlZip?, urlPdf?, clienteNombre, emails[], total?, vence? }
// opts:  { resendKey, from, replyTo?, bcc?, emisorNit, emisorNombre, para? (reemplaza destinatarios: prueba),
//          esperas? (ms entre intentos de bajar el ZIP), fetchFn?, sleep? }
// Devuelve { ok, id?, para?, error?, indeterminado? }. indeterminado = el correo PUDO salir (no reintentar a ciegas).
export async function enviarFacturaCliente(datos, opts = {}) {
  const f = opts.fetchFn || fetch;
  const sleep = opts.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  if (!opts.resendKey) return { ok: false, error: 'Falta RESEND_API_KEY en el worker' };
  if (!datos || !datos.numero) return { ok: false, error: 'Falta el número de la factura' };
  const para = correosValidos(opts.para || datos.emails);
  if (!para.length) return { ok: false, error: 'El cliente no tiene correo registrado en Aliaddo' };
  const zipUrl = zipDesdeUrls(datos.urlZip, datos.urlPdf);
  if (!zipUrl) return { ok: false, error: 'No hay URL del ZIP oficial de la factura' };

  // Bajar el ZIP oficial; reintenta unos segundos por si Aliaddo aún no lo ha publicado
  let buf = null, ultimo = '';
  for (const ms of (opts.esperas || [0, 2500, 5000])) {
    if (ms) await sleep(ms);
    try {
      const s = await urlFirmadaAliaddo(zipUrl, f);
      if (!s) { ultimo = 'Aliaddo no dio URL firmada'; continue; }
      const r = await f(s);
      if (!r.ok) { ultimo = 'HTTP ' + r.status; continue; }
      const b = await r.arrayBuffer();
      const u8 = new Uint8Array(b);
      if (u8.length < 4 || u8[0] !== 0x50 || u8[1] !== 0x4b) { ultimo = 'el archivo no es un ZIP'; continue; }
      buf = b; break;
    } catch (e) { ultimo = e.message; }
  }
  if (!buf) return { ok: false, error: `No se pudo bajar el ZIP de la factura ${datos.numero} (${ultimo})` };
  if (buf.byteLength > MAX_ZIP) return { ok: false, error: `El ZIP de la factura pesa ${buf.byteLength} bytes (> 2 MB, límite DIAN)` };
  const numeroZip = await numeroEnZip(buf);
  if (!numeroZip) return { ok: false, error: `No pude leer el número de factura dentro del ZIP; no se envía la ${datos.numero}` };
  if (!mismoNumero(numeroZip, datos.numero)) return { ok: false, error: `El ZIP es de la factura ${numeroZip}, no de la ${datos.numero}; no se envía` };

  const html = `<p>Señores <b>${esc(datos.clienteNombre || '')}</b>:</p>
<p>Adjuntamos la factura electrónica de venta No. <b>${esc(datos.numero)}</b> de ${esc(opts.emisorNombre)}${datos.total ? ' por ' + cop(datos.total) : ''}${datos.vence ? ', con vencimiento ' + esc(datos.vence) : ''}.</p>
<p>El archivo ZIP contiene el documento electrónico validado por la DIAN (XML) y su representación gráfica (PDF).</p>
<p>Cordialmente,<br>${esc(opts.emisorNombre)}</p>`;
  const body = {
    from: opts.from,
    to: para,
    subject: asuntoDian({ emisorNit: opts.emisorNit, emisorNombre: opts.emisorNombre, numero: numeroZip }),
    html,
    attachments: [{ filename: zipUrl.split('/').pop(), content: b64(buf) }],
  };
  if (opts.replyTo) body.reply_to = opts.replyTo;
  const bcc = correosValidos(opts.bcc ? [opts.bcc] : []).filter(c => !para.includes(c));
  if (bcc.length) body.bcc = bcc;

  let r;
  try {
    r = await f('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.resendKey}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, indeterminado: true, error: `Sin respuesta de Resend (${e.message}); verifica si el correo salió antes de reenviar` };
  }
  const out = await r.json().catch(() => ({}));
  if (!r.ok) {
    return { ok: false, indeterminado: r.status >= 500, error: `Resend ${r.status}: ${JSON.stringify(out).slice(0, 200)}` };
  }
  return { ok: true, id: out.id || null, para };
}
