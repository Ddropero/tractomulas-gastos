// ============================================================
// Tractomulas Gastos — Worker Cloudflare
// 3 agentes en paralelo con Promise.all()
// Bindings: DB (D1) | BUCKET (R2) | ANTHROPIC_API_KEY (secret)
// ============================================================

import { runAgent1 } from './agent1-fiscal.js';
import { runAgent2 } from './agent2-provider.js';
import { runAgent3 } from './agent3-classification.js';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' }
  });
}

// ── Merge de los 3 resultados ────────────────────────────────
function mergeAgents(a1, a2, a3, usuario, vehiculoParam) {
  const errores = [a1, a2, a3]
    .filter(a => a.error)
    .map(a => `Agente ${a.agent}: ${a.error}`);

  const nit = a2.emisor?.nit || null;
  const nombreProveedor = a2.catalogo_match?.nombre_corto
    || a2.emisor?.nombre_comercial
    || a2.emisor?.razon_social
    || 'Proveedor desconocido';

  const categoria = a3.categoria
    || a2.catalogo_match?.categoria_default
    || 'Misceláneos';

  // Vehículo: prioridad param > agente3 > null
  const vehiculo = vehiculoParam || a3.vehiculo_detectado || null;

  const confianzaMap = { alta: 3, media: 2, baja: 1 };
  const confianzaMin = Math.min(
    confianzaMap[a1.confianza] || 1,
    confianzaMap[a2.confianza] || 1,
    confianzaMap[a3.confianza] || 1
  );
  const confianza = Object.keys(confianzaMap).find(k => confianzaMap[k] === confianzaMin);
  const estado = (confianza === 'baja' || errores.length > 0) ? 'revision' : 'confirmado';

  return {
    proveedor_nit:        nit,
    proveedor_nombre:     nombreProveedor,
    numero_documento:     a1.numero_documento || null,
    tipo_documento:       a1.tipo_documento || 'otro',
    fecha:                a1.fecha_pago || a1.fecha_emision || null,
    vehiculo,
    categoria,
    concepto:             a3.concepto || 'Sin concepto',
    ruta:                 a3.ruta || null,
    kilometraje:          a3.kilometraje || null,
    valor_base:           a1.valores?.subtotal || 0,
    iva:                  a1.valores?.iva || 0,
    inc:                  a1.valores?.inc || 0,
    otros_impuestos:      (a1.valores?.impo_consumo || 0) + (a1.valores?.otros_impuestos || 0),
    total:                a1.valores?.total || 0,
    es_nota_credito:      a1.es_nota_credito || false,
    medio_pago:           a1.medio_pago || null,
    referencia_pago:      a1.referencia_pago || null,
    usuario,
    estado,
    confianza_global:     confianza,
    errores_parciales:    errores.length > 0 ? errores : null,
    notas:                a3.notas_clasificacion || null,
  };
}

async function checkDuplicate(db, numeroDocumento, total, fecha, proveedorNit) {
  if (!db) return null;
  if (numeroDocumento) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE numero_documento = ?'
    ).bind(numeroDocumento).first();
    if (row) return { tipo: 'numero_documento', registro: row };
  }
  if (total && fecha && proveedorNit) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ? AND proveedor_nit = ?'
    ).bind(total, fecha, proveedorNit).first();
    if (row) return { tipo: 'total_fecha_proveedor', registro: row };
  }
  if (total && fecha) {
    const row = await db.prepare(
      'SELECT id, numero, proveedor_nombre, total FROM gastos WHERE ABS(total - ?) < 1 AND fecha = ?'
    ).bind(total, fecha).first();
    if (row) return { tipo: 'total_fecha', registro: row };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

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

        const apiKey = env.ANTHROPIC_API_KEY;
        const [a1, a2, a3] = await Promise.all([
          runAgent1(b64, mimeType, apiKey),
          runAgent2(b64, mimeType, env.DB, apiKey),
          runAgent3(b64, mimeType, apiKey)
        ]);

        await r2Promise;

        const preview = mergeAgents(a1, a2, a3, usuario, vehiculo);
        preview.archivo_r2 = r2Key;
        const dup = await checkDuplicate(env.DB, preview.numero_documento, preview.total, preview.fecha, preview.proveedor_nit);
        preview.es_posible_duplicado = !!dup;
        preview.duplicado_info = dup;

        return json({ ok: true, preview });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── POST /api/confirm ───────────────────────────────────
    if (request.method === 'POST' && url.pathname === '/api/confirm') {
      try {
        const body = await request.json();

        const dup = await checkDuplicate(env.DB, body.numero_documento, body.total, body.fecha, body.proveedor_nit);
        if (dup) {
          const r = dup.registro;
          return json({ ok: false, error: `Duplicado (#${r.numero} — ${r.proveedor_nombre})`, duplicado: true }, 409);
        }

        if (!body.vehiculo) {
          return json({ ok: false, error: 'Selecciona un vehículo' }, 400);
        }

        const maxRow = await env.DB.prepare('SELECT MAX(numero) as max FROM gastos').first();
        const numero = (maxRow?.max || 0) + 1;

        await env.DB.prepare(`
          INSERT INTO gastos
            (numero, fecha, vehiculo, proveedor_nit, proveedor_nombre, numero_documento,
             concepto, categoria, valor_base, iva, inc, otros_impuestos,
             total, es_nota_credito, medio_pago, referencia_pago,
             kilometraje, ruta, archivo_r2, usuario, estado, notas)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          numero, body.fecha, body.vehiculo, body.proveedor_nit, body.proveedor_nombre,
          body.numero_documento, body.concepto, body.categoria,
          body.valor_base || 0, body.iva || 0, body.inc || 0,
          body.otros_impuestos || 0, body.total,
          body.es_nota_credito ? 1 : 0,
          body.medio_pago, body.referencia_pago,
          body.kilometraje || null, body.ruta || null,
          body.archivo_r2, body.usuario || 'david',
          body.estado || 'confirmado', body.notas || null
        ).run();

        return json({ ok: true, numero }, 201);
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    // ── DELETE /api/gastos/:id ──────────────────────────────
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/gastos/')) {
      try {
        const id = parseInt(url.pathname.split('/').pop());
        if (!id) return json({ error: 'ID inválido' }, 400);

        const row = await env.DB.prepare('SELECT id, numero, archivo_r2 FROM gastos WHERE id = ?').bind(id).first();
        if (!row) return json({ error: 'Registro no encontrado' }, 404);

        if (row.archivo_r2) {
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
      const total  = result.results.reduce((s, r) => s + r.total, 0);
      const porCategoria = result.results.reduce((acc, r) => {
        acc[r.categoria] = (acc[r.categoria] || 0) + r.total;
        return acc;
      }, {});
      const porVehiculo = result.results.reduce((acc, r) => {
        acc[r.vehiculo] = (acc[r.vehiculo] || 0) + r.total;
        return acc;
      }, {});

      return json({
        registros: result.results,
        total_registros: result.results.length,
        gran_total: total,
        por_categoria: porCategoria,
        por_vehiculo: porVehiculo
      });
    }

    // ── GET /api/soporte/* ────────────────────────────────────
    if (request.method === 'GET' && url.pathname.startsWith('/api/soporte/')) {
      try {
        const key = url.pathname.replace('/api/soporte/', '');
        if (!key) return json({ error: 'Key requerida' }, 400);

        const obj = await env.BUCKET.get(key);
        if (!obj) return json({ error: 'Archivo no encontrado' }, 404);

        return new Response(obj.body, {
          headers: {
            ...CORS_HEADERS,
            'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
            'Content-Disposition': `inline; filename="${key.split('/').pop()}"`,
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (err) {
        return json({ error: err.message }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  }
};
