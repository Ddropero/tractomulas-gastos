// ============================================================
// Cliente de la API de Aliaddo — facturación electrónica por API key
// Auth: Authorization: Bearer <token>  ·  Base: https://app.aliaddo.net/v1
// Descubre cliente/sucursal/ítem vía la API (sin hardcodear IDs de la cuenta).
// ============================================================
const BASE = 'https://app.aliaddo.net/v1';

async function aliGet(token, path) {
  let res, txt;
  try {
    res = await fetch(BASE + path, { headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/json' } });
    txt = await res.text();
  } catch (e) { return { ok: false, status: 0, data: 'network:' + e.message }; }
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { ok: res.ok, status: res.status, data };
}
async function aliPost(token, path, body) {
  let res, txt;
  try {
    res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    txt = await res.text();
  } catch (e) { return { ok: false, status: 0, data: 'network:' + e.message }; }
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { ok: res.ok, status: res.status, data };
}

// La API puede envolver la lista en data/items/results/value; normaliza
function listOf(d) {
  if (Array.isArray(d)) return d;
  for (const k of ['data', 'items', 'results', 'value', 'content']) if (d && Array.isArray(d[k])) return d[k];
  return [];
}
const idOf = (o) => o && (o.id || o.personId || o.branchId || o.itemId || o._id) || null;

// Dígito de verificación DIAN de un NIT
function nitDV(nit) {
  const pesos = [3, 7, 13, 17, 19, 23, 29, 37, 41, 43, 47, 53, 59, 67, 71];
  const d = String(nit).replace(/\D/g, '').split('').reverse();
  let s = 0;
  for (let i = 0; i < d.length; i++) s += (parseInt(d[i], 10) || 0) * (pesos[i] || 0);
  const r = s % 11;
  return String(r < 2 ? r : 11 - r);
}
// Separa base + DV de un NIT ('900768035-9' → {base:'900768035', dv:'9'})
function splitNit(raw) {
  const s = String(raw || '').trim();
  if (s.includes('-')) {
    const [b, d] = s.split('-');
    const base = b.replace(/\D/g, '');
    const dvLeido = (d || '').replace(/\D/g, '') || null;
    // dv = calculado (correcto por definición); dvLeido permite detectar NIT mal leídos
    return { base, dv: nitDV(base), dvLeido, dvOk: dvLeido == null || dvLeido === nitDV(base) };
  }
  const digits = s.replace(/\D/g, '');
  if (digits.length === 10) {
    const b9 = digits.slice(0, 9);
    // Solo es "NIT 9 + DV" si empieza por 8/9 y el último dígito ES su DV; si no, es una cédula de 10
    if (/^[89]/.test(digits) && digits.slice(9) === nitDV(b9)) return { base: b9, dv: digits.slice(9), dvLeido: digits.slice(9), dvOk: true };
  }
  return { base: digits, dv: nitDV(digits), dvLeido: null, dvOk: true };
}

// Diagnóstico: descubre la configuración de la cuenta (para verificar token + IDs)
export async function aliaddoDiagnostico(token) {
  if (!token) return { error: 'ALIADDO_API_KEY no configurado' };
  const [br, it] = await Promise.all([
    aliGet(token, '/branches?itemsPerPage=10'),
    aliGet(token, '/items?itemsPerPage=50'),
  ]);
  if (br.status === 401 || it.status === 401) return { error: 'Token inválido (401). Revisa ALIADDO_API_KEY.' };
  const items = listOf(it.data);
  const flete = items.find(x => /flete/i.test((x.name || '') + ' ' + (x.description || '')));
  return {
    ok: true,
    sucursales: listOf(br.data).map(b => ({ id: idOf(b), nombre: b.name || b.branchName })),
    item_fletes: flete ? { id: idOf(flete), name: flete.name, code: flete.code } : null,
    total_items: items.length,
    branches_status: br.status, items_status: it.status
  };
}

// Diagnóstico de FACTURACIÓN (solo lectura): sucursales con isDefault/status + últimas facturas emitidas,
// para saber con qué sucursal/prefijo se ha facturado con éxito (las resoluciones no están en la API).
export async function diagnosticoFacturacionAliaddo(token) {
  if (!token) return { error: 'Token de Aliaddo no configurado' };
  const [br, inv] = await Promise.all([
    aliGet(token, '/branches?itemsPerPage=10'),
    aliGet(token, '/invoices?itemsPerPage=10&page=1'),
  ]);
  if (br.status === 401) return { error: 'Token inválido (401)' };
  const sucursales = listOf(br.data).map(b => ({ id: idOf(b), nombre: b.name || '', isDefault: b.isDefault, status: b.status }));
  const facturas = listOf(inv.data);
  const pick = (o, ks) => { const r = {}; for (const k of ks) if (o && o[k] !== undefined) r[k] = o[k]; return r; };
  return {
    ok: true,
    sucursales,
    facturas_status: inv.status,
    campos_factura: facturas[0] ? Object.keys(facturas[0]) : [],
    ultimas_facturas: facturas.slice(0, 10).map(f => pick(f, ['consecutive', 'date', 'createdAt', 'branchId', 'branchName', 'branch', 'status', 'statusDian', 'stateDian', 'prefix', 'total', 'totalAmount', 'personName', 'resolution', 'resolutionNumber'])),
  };
}

// Lista los clientes/terceros registrados en Aliaddo (GET /v1/people)
export async function listarClientesAliaddo(token, opts = {}) {
  if (!token) return { error: 'ALIADDO_API_KEY no configurado' };
  const p = new URLSearchParams();
  p.set('itemsPerPage', String(Math.min(opts.itemsPerPage || 50, 50)));
  p.set('page', String(opts.page || 1));
  if (opts.identification) p.set('identification', opts.identification);
  if (opts.email) p.set('email', opts.email);
  const r = await aliGet(token, '/people?' + p.toString());
  if (r.status === 401) return { error: 'Token inválido (401). Revisa el token de Aliaddo.' };
  if (!r.ok) return { error: `Aliaddo /people ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
  const clientes = listOf(r.data).map(x => ({
    id: idOf(x),
    nombre: x.name || x.tradeName || x.razonSocial || '',
    identificacion: x.identification || '',
    tipo: x.kind || x.identificationType || '',
    email: x.email || (Array.isArray(x.emails) && x.emails[0] && (x.emails[0].email || x.emails[0])) || '',
    ciudad: x.cityName || x.city || ''
  }));
  return { ok: true, clientes, total: clientes.length, page: opts.page || 1 };
}

// Identificación exacta: base o base+DV. Nunca "el primero de la lista".
const soloDig = s => String(s || '').replace(/\D/g, '');
function mismaIdentificacion(p, base, dv) {
  const id = soloDig(p && p.identification);
  return !!id && (id === base || id === base + dv);
}
// Distancia de edición (para detectar el nombre propio mal leído: "DOCE DOCEMAS", "DOBE DOCENAS")
function lev(a, b) {
  const m = a.length, n = b.length, dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[m][n];
}
function esLaEmisora(nombre, nitBase, emisorNit) {
  const emisor = soloDig(emisorNit || '900768035').slice(0, 9);
  if (nitBase && nitBase.slice(0, 9) === emisor) return true;
  const n = String(nombre || '').toLowerCase().normalize('NFD').replace(/[^a-z]/g, '').replace(/(sas|sa|ltda)$/, '');
  return n.length >= 8 && lev(n, 'docedocenas') <= 2;
}
// Fecha de hoy en Bogotá (UTC-5 fijo)
const hoyBogota = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const SUCURSAL_FACTURACION = '0e9da9d1-8648-11ef-b41f-42010a32b12c'; // con resolución DIAN

// Emite la factura electrónica de un viaje. viaje = fila de la tabla viajes.
// opts.dryRun = true → arma y devuelve la factura SIN enviarla ni crear el cliente.
export async function facturarViajeAliaddo(token, viaje, opts = {}) {
  if (!token) return { error: 'Token de Aliaddo no configurado en el worker' };
  const dry = !!opts.dryRun;
  const { base: nitBase, dv: nitDv, dvLeido, dvOk } = splitNit(viaje.empresa_carga_nit);
  if (!nitBase) return { error: 'El viaje no tiene NIT del cliente (empresa_carga_nit)', motivo: 'sin_nit' };
  const valor = Math.round(Number(viaje.valor_flete) || 0);
  if (!(valor > 0)) return { error: 'El viaje no tiene un valor de flete válido', motivo: 'sin_valor' };

  // Guarda 1: nunca facturarse a sí misma (el OCR a veces lee la empresa de transporte como cliente)
  if (esLaEmisora(viaje.empresa_carga, nitBase, opts.emisorNit)) {
    return { error: `El cliente del viaje es la propia empresa emisora ("${viaje.empresa_carga || ''}" NIT ${viaje.empresa_carga_nit || ''}). El manifiesto probablemente se leyó con la empresa de transporte en vez del cliente: corrige el cliente (quien contrató el flete) antes de facturar.`, motivo: 'cliente_es_emisor' };
  }
  // Guarda 2: un DV que no cuadra = NIT mal leído → no emitir a un NIT equivocado
  if (!dvOk) {
    return { error: `El NIT del cliente "${viaje.empresa_carga_nit}" no es válido: para ${nitBase} el dígito de verificación debería ser ${nitDv}, no ${dvLeido}. Probablemente un dígito quedó mal leído del manifiesto; corrige el NIT del viaje.`, motivo: 'dv_invalido' };
  }

  // 1. Cliente por NIT — match EXACTO (base o base+DV)
  const cli = await aliGet(token, `/people?identification=${encodeURIComponent(nitBase)}&itemsPerPage=10`);
  if (cli.status === 401) return { error: 'Token inválido (401). Revisa el token de Aliaddo.' };
  if (!cli.ok) return { error: `Aliaddo /people ${cli.status}: ${JSON.stringify(cli.data).slice(0, 200)}` };
  const persona = listOf(cli.data).find(p => mismaIdentificacion(p, nitBase, nitDv));
  let personId = idOf(persona);
  const nitVerificado = dvLeido != null && dvOk; // el NIT trae DV y cuadra
  const emailsDe = p => (Array.isArray(p && p.emails) ? p.emails : []).map(e => (e && (e.email || e)) || '').filter(Boolean);
  const cliente = persona
    ? { existe: true, id: personId, nombre: persona.name || persona.companyName || persona.tradeName || '', identificacion: persona.identification, emails: emailsDe(persona) }
    : { existe: false, se_crearia: { nit: `${nitBase}-${nitDv}`, razon_social: viaje.empresa_carga || null, email: opts.clienteEmail || null } };

  // 1b. Si no existe, crearlo (solo al emitir de verdad; nunca con razón social inventada
  //     ni con un NIT sin verificar — un NIT mal leído crearía un cliente basura)
  if (!personId) {
    if (!viaje.empresa_carga || !String(viaje.empresa_carga).trim()) {
      return { error: `El cliente NIT ${nitBase}-${nitDv} no existe en Aliaddo y el viaje no tiene razón social (empresa_carga). Complétala antes de facturar.`, motivo: 'sin_razon_social' };
    }
    if (!nitVerificado && !opts.permitirCrearCliente) {
      return { error: `El cliente "${viaje.empresa_carga}" (NIT ${nitBase}) no existe en Aliaddo y su NIT no trae dígito de verificación para comprobar que esté bien leído. Verifica el NIT y escríbelo con DV (ej. ${nitBase}-${nitDv}) en el viaje; así se crea el cliente y se factura.`, motivo: 'cliente_nuevo_sin_verificar', cliente };
    }
    if (!dry) {
      const nuevo = {
        kind: 'Company', identificationType: '31',
        identification: nitBase, identificationCheck: nitDv,
        companyName: String(viaje.empresa_carga).trim(), isCustomer: true
      };
      // Correo de recepción de facturas electrónicas del cliente
      if (opts.clienteEmail) nuevo.emails = [{ email: String(opts.clienteEmail).trim(), isMain: true }];
      const crea = await aliPost(token, '/people', nuevo);
      if (!crea.ok) return { error: `No se pudo crear el cliente NIT ${nitBase} en Aliaddo (${crea.status}): ${JSON.stringify(crea.data).slice(0, 300)}` };
      personId = idOf(crea.data) || idOf(crea.data && crea.data.data);
      if (!personId) {
        const cli2 = await aliGet(token, `/people?identification=${encodeURIComponent(nitBase)}&itemsPerPage=10`);
        personId = idOf(listOf(cli2.data).find(p => mismaIdentificacion(p, nitBase, nitDv)));
      }
      if (!personId) return { error: 'Cliente creado en Aliaddo pero no obtuve su id; reintenta facturar.' };
    }
  }

  // 2. Sucursal de facturación: validada; si no existe → error explícito (no caer a otra)
  const pref = opts.branchId || SUCURSAL_FACTURACION;
  const br = await aliGet(token, '/branches?itemsPerPage=10');
  if (!br.ok) return { error: `Aliaddo /branches ${br.status}` };
  const branches = listOf(br.data);
  const branch = branches.find(b => idOf(b) === pref);
  if (!branch) return { error: `La sucursal de facturación ${pref} no existe en Aliaddo. Disponibles: ${branches.map(b => idOf(b) + ' (' + (b.name || '') + ')').join('; ')}` };
  const branchId = idOf(branch);

  // 3. Ítem "fletes" — la API factura por CÓDIGO (itemCode), no por id
  let itemCode = opts.itemFletesCode ? String(opts.itemFletesCode) : null;
  let itemNombre = null;
  if (!itemCode) {
    const it = await aliGet(token, '/items?itemsPerPage=50');
    if (!it.ok) return { error: `Aliaddo /items ${it.status}` };
    const items = listOf(it.data);
    const flete = items.find(x => String(x.code) === '15') || items.find(x => /^fletes?$/i.test(String(x.name || '').trim()));
    if (flete && flete.code != null) { itemCode = String(flete.code); itemNombre = flete.name || null; }
  }
  if (!itemCode) return { error: 'No se encontró el ítem "fletes" (código 15) en Aliaddo' };

  // 4. Fecha de emisión = HOY (Bogotá). La fecha del servicio va en la observación.
  const fecha = opts.hoy || hoyBogota();
  const dueDate = opts.dueDate || fecha;
  const servicio = String(viaje.fecha_viaje || '').slice(0, 10);
  const concepto = (opts.concepto || `Servicio de transporte de carga${viaje.numero_manifiesto ? ' - Manifiesto ' + viaje.numero_manifiesto : ''}${viaje.origen ? ' (' + viaje.origen + (viaje.destino ? ' - ' + viaje.destino : '') + ')' : ''}${servicio ? ' - Fecha servicio ' + servicio : ''}`).slice(0, 250);

  // 5. Payload según la especificación oficial de POST /v1/invoices
  const payload = {
    personId: personId || '(se crea al emitir)',
    date: fecha,
    dueDate,
    paymentFormCode: 'CR',
    paymentMeanCode: String(opts.paymentMeanCode || '10'),
    branchId,
    observation: concepto,
    details: [{ itemCode, quantity: '1', unitValueBeforeTax: String(valor), description: concepto }],
  };
  if (opts.costCenterId) payload.costCenterId = opts.costCenterId;
  if (opts.purchaseOrderNumber) payload.purchaseOrderNumber = String(opts.purchaseOrderNumber).slice(0, 60);

  if (dry) {
    return { ok: true, dryRun: true, cliente, sucursal: { id: branchId, nombre: branch.name || '' }, item: { code: itemCode, nombre: itemNombre }, total: valor, fecha_emision: fecha, vence: dueDate, payload };
  }

  // 6. Emitir. Un POST de factura NUNCA se reintenta automáticamente.
  const inv = await aliPost(token, '/invoices', payload);
  if (!inv.ok) {
    // Sin respuesta o 5xx: la factura PUDO quedar creada → indeterminado (bloquea reintento ciego)
    const indeterminado = inv.status === 0 || inv.status >= 500;
    return {
      error: `Aliaddo /invoices ${inv.status || 'sin respuesta'}: ${JSON.stringify(inv.data).slice(0, 400)}${indeterminado ? ' — VERIFICA en Aliaddo si la factura quedó creada antes de reintentar.' : ''}`,
      indeterminado, payload,
    };
  }
  const d0 = inv.data || {};
  const d = (d0.data && typeof d0.data === 'object' && !Array.isArray(d0.data)) ? d0.data : d0;
  const numero = d.consecutive != null ? String(d.consecutive) : (d.number != null ? String(d.number) : null);
  if (!d.id && !numero) {
    return { error: `Aliaddo respondió ${inv.status} pero sin id ni número de factura. NO reintentes sin verificar en Aliaddo.`, indeterminado: true, raw: d0 };
  }
  return {
    ok: true, invoice_id: d.id || null, numero, cufe: d.cufe || null,
    state_dian: d.stateDian || null, status_dian: d.statusDian || null,
    motivo_dian: Array.isArray(d.stateDianReason) ? d.stateDianReason.join('; ') : (d.stateDianReason || null),
    url_pdf: d.urlPdf || null, url_zip: d.urlZip || null,
    // Para enviar la factura al cliente (correos registrados en Aliaddo o el del cliente recién creado)
    cliente_nombre: (persona && (persona.name || persona.companyName || persona.tradeName)) || viaje.empresa_carga || '',
    cliente_emails: persona ? emailsDe(persona) : (opts.clienteEmail ? [String(opts.clienteEmail).trim()] : []),
    total: valor, vence: dueDate,
    raw: d,
  };
}

// Factura MANUAL (p.ej. una "corrida" que agrupa varios viajes en una sola factura).
// Reusa el mismo núcleo seguro (guardas de emisora, DV, cliente exacto, sucursal, itemCode, fecha hoy).
// datos = { nit:'901101271-1', razon_social, email, concepto, valor, orden_compra?, medio_pago? }
export async function facturaManualAliaddo(token, datos = {}, opts = {}) {
  const valor = Math.round(Number(datos.valor) || 0);
  const concepto = String(datos.concepto || '').trim();
  if (!concepto) return { error: 'Falta el concepto de la factura', motivo: 'sin_concepto' };
  const email = datos.email ? String(datos.email).trim() : null;
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: `Correo del cliente inválido: ${email}`, motivo: 'email_invalido' };
  const pseudoViaje = { empresa_carga: datos.razon_social, empresa_carga_nit: datos.nit, valor_flete: valor };
  return facturarViajeAliaddo(token, pseudoViaje, {
    ...opts,
    concepto,
    clienteEmail: email,
    purchaseOrderNumber: datos.orden_compra || null,
    paymentMeanCode: datos.medio_pago || opts.paymentMeanCode,
  });
}

// Aliaddo NO envía la factura al cliente cuando se crea por API, y el token de API no puede pedírselo:
// /v1 no tiene envío (404) y la ruta de la web (PATCH /invoices/sendEmails?replyTo=…) responde 401 al token.
// Por eso el envío al cliente lo hace el worker (factura-email.js). Esta prueba sin efectos queda para
// detectar si Aliaddo algún día habilita el envío para el token.
const SEND_EMAIL_URLS = [BASE + '/invoices/sendEmails', 'https://app.aliaddo.net/invoices/sendEmails'];

async function aliPatchUrl(token, url, body) {
  let res, txt;
  try {
    res = await fetch(url, {
      method: 'PATCH',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    txt = await res.text();
  } catch (e) { return { ok: false, status: 0, data: 'network:' + e.message }; }
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { ok: res.ok, status: res.status, data };
}

// La ruta EXIGE ?replyTo= (sin él Aliaddo responde 405 "no admite PATCH")
const REPLY_TO_DEFAULT = 'ddropero@gmail.com';

// Datos de una factura ya emitida para enviarla por correo (reenvío manual): número, cliente y sus correos
export async function datosFacturaAliaddo(token, invoiceId) {
  const inv = await aliGet(token, `/invoices/${encodeURIComponent(invoiceId)}`);
  if (!inv.ok) return { error: `Aliaddo /invoices/${invoiceId} ${inv.status}` };
  const d = (inv.data && inv.data.data && typeof inv.data.data === 'object') ? inv.data.data : (inv.data || {});
  if (!d.personId) return { error: 'La factura no tiene cliente (personId)' };
  const per = await aliGet(token, `/people/${encodeURIComponent(d.personId)}`);
  const p = (per.data && per.data.data && typeof per.data.data === 'object') ? per.data.data : (per.data || {});
  const emails = (Array.isArray(p.emails) ? p.emails : []).map(e => (e && (e.email || e)) || '').filter(Boolean);
  return {
    ok: true, invoice_id: d.id || invoiceId, numero: d.consecutive != null ? String(d.consecutive) : null,
    state_dian: d.stateDian || null, cliente_nombre: d.personName || p.companyName || p.name || '',
    cliente_emails: emails, total: Math.round(Number(d.totalAmount) || 0), vence: String(d.dueDate || '').slice(0, 10),
  };
}

// Prueba SIN efectos: manda una lista vacía de facturas a cada ruta para ver cuál existe y acepta el token.
// Si la ruta sirve, Aliaddo responde 400 {code:463,"¡No hay documentos para enviar!"}; 401/403 = token no aceptado.
export async function probarEnvioEmailAliaddo(token) {
  const out = [];
  for (const u of SEND_EMAIL_URLS) {
    const r = await aliPatchUrl(token, u + '?replyTo=' + encodeURIComponent(REPLY_TO_DEFAULT), []);
    out.push({ ruta: u.replace('https://app.aliaddo.net', ''), status: r.status, respuesta: typeof r.data === 'string' ? r.data.slice(0, 160) : r.data });
  }
  return { ok: true, rutas: out };
}

// Construye el payload para crear un proveedor (Company si NIT de empresa, Person si CC)
function proveedorPayload(nitBase, dv, nombre) {
  const n = nombre || '';
  const esEmpresa = /^(8|9)\d{8}$/.test(nitBase) || /\b(s\.?a\.?s|ltda|s\.?a\.?\b|e\.?u|sca|cia|compañ|corp|inc|group|s\.?a\.?s\.?)\b/i.test(n);
  if (esEmpresa) {
    return { kind: 'Company', identificationType: '31', identification: nitBase, identificationCheck: dv, companyName: n || ('Proveedor ' + nitBase), isSupplier: true };
  }
  const parts = n.trim().split(/\s+/).filter(Boolean);
  let firstName = '', secondName = '', firstSurname = '', secondSurname = '';
  if (parts.length >= 4) { firstName = parts[0]; secondName = parts[1]; firstSurname = parts[2]; secondSurname = parts.slice(3).join(' '); }
  else if (parts.length === 3) { firstName = parts[0]; firstSurname = parts[1]; secondSurname = parts[2]; }
  else if (parts.length === 2) { firstName = parts[0]; firstSurname = parts[1]; }
  else { firstName = parts[0] || ('Proveedor ' + nitBase); firstSurname = '.'; }
  return { kind: 'Person', identificationType: '13', identification: nitBase, firstName, secondName, firstSurname, secondSurname, isSupplier: true };
}

// Plan de cuentas (PUC) de Aliaddo
export async function listarCuentasAliaddo(token, opts = {}) {
  if (!token) return { error: 'ALIADDO_API_KEY no configurado' };
  const page = opts.page || 1;
  const r = await aliGet(token, `/chart-accounts?page=${page}&itemPerPage=50`);
  if (r.status === 401) return { error: 'Token inválido (401). Revisa el token de Aliaddo.' };
  if (r.status === 404) return { error: 'El plan de cuentas (PUC) no responde (404). Probablemente el módulo de Contabilidad no está activo en tu Aliaddo, o el token no tiene ese permiso. Actívalo en Aliaddo (Configuración → Contabilidad) o pregúntale a soporte por el endpoint /v1/chart-accounts.' };
  if (!r.ok) return { error: `Aliaddo /chart-accounts ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
  const cuentas = listOf(r.data).map(x => ({ id: idOf(x), code: x.code || x.accountCode || x.puc || '', name: x.name || x.accountName || x.description || '' }));
  return { ok: true, cuentas, page, total: cuentas.length };
}

// Tipos de comprobante contable de Aliaddo
export async function listarComprobantesAliaddo(token) {
  if (!token) return { error: 'ALIADDO_API_KEY no configurado' };
  const r = await aliGet(token, '/document-types?page=1&itemPerPage=50');
  if (r.status === 401) return { error: 'Token inválido (401).' };
  if (!r.ok) return { error: `Aliaddo /document-types ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}` };
  const tipos = listOf(r.data).map(x => ({ id: idOf(x), code: x.code || '', name: x.name || x.description || '' }));
  return { ok: true, tipos };
}

// Genera el DOCUMENTO SOPORTE (compra a no obligado a facturar) de un gasto. gasto = fila de gastos.
export async function generarSoporteGasto(token, gasto, opts = {}) {
  if (!token) return { error: 'ALIADDO_API_KEY no configurado' };
  const { base: nitBase, dv } = splitNit(gasto.proveedor_nit);
  if (!nitBase) return { error: `El gasto #${gasto.numero || gasto.id} no tiene NIT/CC del proveedor` };
  const valor = Math.round(gasto.total || 0);
  if (!valor) return { error: 'El gasto no tiene valor' };

  // 1. Proveedor: buscar o crear (isSupplier)
  const cli = await aliGet(token, `/people?identification=${encodeURIComponent(nitBase)}&itemsPerPage=10`);
  if (cli.status === 401) return { error: 'Token inválido (401). Revisa el token de Aliaddo.' };
  let personId = idOf(listOf(cli.data).find(p => String(p.identification || '').replace(/\D/g, '') === nitBase) || listOf(cli.data)[0]);
  if (!personId) {
    const pl = proveedorPayload(nitBase, dv, gasto.proveedor_nombre);
    const crea = await aliPost(token, '/people', pl);
    if (!crea.ok) return { error: `No se pudo crear el proveedor ${nitBase} en Aliaddo (${crea.status}): ${JSON.stringify(crea.data).slice(0, 300)}`, payload: pl };
    personId = idOf(crea.data) || idOf(crea.data && crea.data.data);
    if (!personId) { const c2 = await aliGet(token, `/people?identification=${encodeURIComponent(nitBase)}&itemsPerPage=5`); personId = idOf(listOf(c2.data)[0]); }
    if (!personId) return { error: 'Proveedor creado pero sin id; reintenta.' };
  }

  // 2. Sucursal + ítem genérico de gasto
  let branchId = opts.branchId;
  if (!branchId) { const br = await aliGet(token, '/branches?itemsPerPage=10'); const bs = listOf(br.data); branchId = idOf(bs.find(b => idOf(b) === '0e9da9d1-8648-11ef-b41f-42010a32b12c')) || idOf(bs[0]); }
  let itemId = opts.itemGastoId;
  if (!itemId) { const it = await aliGet(token, '/items?itemsPerPage=50'); itemId = idOf(listOf(it.data).find(x => /(gasto|servicio|varios|otros|compra)/i.test(x.name || ''))); }
  if (!itemId) return { error: 'No hay un ítem genérico de gasto en Aliaddo. Crea uno (ej. "Gastos operativos") o pásame su id.' };

  // 3. Crear documento soporte
  const fecha = (gasto.fecha || '').slice(0, 10);
  const concepto = (gasto.concepto || gasto.proveedor_nombre || 'Gasto operativo').slice(0, 250);
  const payload = {
    kindCode: 'Documento soporte', personId, branchId,
    paymentFormCode: 'CN', paymentMeanCode: '10',
    date: fecha, dueDate: fecha, observation: concepto,
    details: [{ itemId, quantity: 1, price: valor, description: concepto }]
  };
  const bill = await aliPost(token, '/bills', payload);
  if (!bill.ok) return { error: `Aliaddo /bills ${bill.status}: ${JSON.stringify(bill.data).slice(0, 400)}`, payload };
  const d = bill.data || {};
  const numero = d.consecutive || d.number || (d.sequence != null ? String(d.sequence) : null);
  return { ok: true, bill_id: d.id || null, numero, cufe: d.cufe || null, raw: d };
}
