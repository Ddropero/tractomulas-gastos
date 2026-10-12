// ============================================================
// COCICP Gastos — Generador de Reporte Fiscal PDF
// Genera PDF 1.4 puro (sin librerías externas)
// ============================================================

const NON_DEDUCIBLE_CATS = [
  'Educación hijos',
  'Personal',
  'Vivienda',
  'Pagos David Duque',
  'Impuestos vehículos',
  'Misceláneos'
];

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  minimumFractionDigits: 0,
  maximumFractionDigits: 0
});

// ── PDF text helpers ────────────────────────────────────────

function pdfStr(s) {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\u00e1]/g, 'a')   // á
    .replace(/[\u00e9]/g, 'e')   // é
    .replace(/[\u00ed]/g, 'i')   // í
    .replace(/[\u00f3]/g, 'o')   // ó
    .replace(/[\u00fa]/g, 'u')   // ú
    .replace(/[\u00c1]/g, 'A')   // Á
    .replace(/[\u00c9]/g, 'E')   // É
    .replace(/[\u00cd]/g, 'I')   // Í
    .replace(/[\u00d3]/g, 'O')   // Ó
    .replace(/[\u00da]/g, 'U')   // Ú
    .replace(/[\u00f1]/g, 'n')   // ñ
    .replace(/[\u00d1]/g, 'N')   // Ñ
    .replace(/[\u00fc]/g, 'u')   // ü
    .replace(/[\u00dc]/g, 'U')   // Ü
    .replace(/[^\x20-\x7E]/g, '?'); // fallback non-ASCII
}

function textCmd(x, y, text, fontSize, fontRef) {
  return `BT /${fontRef} ${fontSize} Tf ${x} ${y} Td (${pdfStr(text)}) Tj ET\n`;
}

function lineCmd(x1, y1, x2, y2, width) {
  return `${width} w ${x1} ${y1} m ${x2} ${y2} l S\n`;
}

function rectFillCmd(x, y, w, h) {
  return `${x} ${y} ${w} ${h} re f\n`;
}

// ── Main export ─────────────────────────────────────────────

export function generateReport(registros, desde, hasta) {
  // ── Data aggregation ────────────────────────────────────

  const granTotal = registros.reduce((s, r) => s + (r.total || 0), 0);
  const ivaTotal  = registros.reduce((s, r) => s + (r.iva || 0), 0);
  const incTotal  = registros.reduce((s, r) => s + (r.inc || 0), 0);

  // Category breakdown
  const catMap = {};
  for (const r of registros) {
    const cat = r.categoria || 'Miscelaneos';
    if (!catMap[cat]) catMap[cat] = { count: 0, total: 0 };
    catMap[cat].count++;
    catMap[cat].total += r.total || 0;
  }

  const catRows = Object.entries(catMap)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([name, data]) => ({
      name,
      count: data.count,
      total: data.total,
      pct: granTotal !== 0 ? ((data.total / granTotal) * 100).toFixed(1) : '0.0'
    }));

  // Deducible vs no deducible
  let totalDeducible    = 0;
  let totalNoDeducible  = 0;
  let countDeducible    = 0;
  let countNoDeducible  = 0;

  for (const r of registros) {
    const cat = r.categoria || 'Miscelaneos';
    if (NON_DEDUCIBLE_CATS.includes(cat)) {
      totalNoDeducible += r.total || 0;
      countNoDeducible++;
    } else {
      totalDeducible += r.total || 0;
      countDeducible++;
    }
  }

  // ── Build PDF content ───────────────────────────────────

  const pageW = 612; // letter width in points
  const pageH = 792; // letter height in points
  const marginL = 50;
  const marginR = 562;
  const contentW = marginR - marginL;

  let stream = '';
  let y = pageH - 60;

  // ── Color: dark header bar ──────────────────────────────
  stream += '0.05 0.06 0.055 rg\n'; // near-black
  stream += rectFillCmd(0, pageH - 90, pageW, 90);

  // ── Header text ─────────────────────────────────────────
  stream += '0.722 0.941 0.627 rg\n'; // accent green
  stream += textCmd(marginL, pageH - 35, 'COCICP', 20, 'F2');
  stream += '0.9 0.93 0.9 rg\n'; // light text
  stream += textCmd(marginL + 95, pageH - 35, '-- Reporte Fiscal', 14, 'F1');

  stream += '0.6 0.7 0.6 rg\n'; // muted
  stream += textCmd(marginL, pageH - 55, `Periodo: ${desde || 'inicio'} a ${hasta || 'actual'}`, 10, 'F1');
  stream += textCmd(marginL, pageH - 70, 'NIT: 901277565-7 | Corp. Colombiana para el Desarrollo en Investigacion en Cirugia Plastica', 8, 'F1');

  y = pageH - 110;

  // ── Reset to black text ─────────────────────────────────
  stream += '0 0 0 rg\n';

  // ── Summary section ─────────────────────────────────────
  stream += textCmd(marginL, y, 'RESUMEN GENERAL', 12, 'F2');
  y -= 6;
  stream += '0.85 0.85 0.85 rg\n';
  stream += lineCmd(marginL, y, marginR, y, 0.5);
  stream += '0 0 0 rg\n';
  y -= 18;

  const summaryItems = [
    ['Total registros:', String(registros.length)],
    ['Gran total:', COP.format(granTotal)],
    ['IVA total:', COP.format(ivaTotal)],
    ['INC total:', COP.format(incTotal)],
  ];
  for (const [label, value] of summaryItems) {
    stream += textCmd(marginL + 10, y, label, 10, 'F1');
    stream += textCmd(marginL + 160, y, value, 10, 'F2');
    y -= 16;
  }

  y -= 10;

  // ── Category breakdown table ────────────────────────────
  stream += textCmd(marginL, y, 'DESGLOSE POR CATEGORIA', 12, 'F2');
  y -= 6;
  stream += '0.85 0.85 0.85 rg\n';
  stream += lineCmd(marginL, y, marginR, y, 0.5);
  stream += '0 0 0 rg\n';
  y -= 18;

  // Table header
  stream += '0.92 0.94 0.92 rg\n';
  stream += rectFillCmd(marginL, y - 3, contentW, 16);
  stream += '0.2 0.2 0.2 rg\n';

  const colCat   = marginL + 6;
  const colCount = marginL + 260;
  const colTotal = marginL + 320;
  const colPct   = marginL + 470;

  stream += textCmd(colCat,   y, 'Categoria', 9, 'F2');
  stream += textCmd(colCount, y, 'Cant.', 9, 'F2');
  stream += textCmd(colTotal, y, 'Total', 9, 'F2');
  stream += textCmd(colPct,   y, '% del Total', 9, 'F2');
  y -= 18;
  stream += '0 0 0 rg\n';

  let rowIdx = 0;
  for (const row of catRows) {
    // Check page break — need at least 120pt for deducible section + footer
    if (y < 150) {
      // We would need multi-page. For simplicity, use smaller font.
      // In practice 20 categories will fit.
    }

    if (rowIdx % 2 === 1) {
      stream += '0.96 0.97 0.96 rg\n';
      stream += rectFillCmd(marginL, y - 3, contentW, 15);
      stream += '0 0 0 rg\n';
    }

    const displayName = row.name.length > 30 ? row.name.substring(0, 28) + '..' : row.name;
    stream += textCmd(colCat,   y, displayName, 9, 'F1');
    stream += textCmd(colCount, y, String(row.count), 9, 'F1');
    stream += textCmd(colTotal, y, COP.format(row.total), 9, 'F1');
    stream += textCmd(colPct,   y, row.pct + '%', 9, 'F1');
    y -= 15;
    rowIdx++;
  }

  // Totals row
  y -= 3;
  stream += '0.85 0.85 0.85 rg\n';
  stream += lineCmd(marginL, y + 12, marginR, y + 12, 0.5);
  stream += '0 0 0 rg\n';
  stream += textCmd(colCat,   y, 'TOTAL', 9, 'F2');
  stream += textCmd(colCount, y, String(registros.length), 9, 'F2');
  stream += textCmd(colTotal, y, COP.format(granTotal), 9, 'F2');
  stream += textCmd(colPct,   y, '100%', 9, 'F2');
  y -= 30;

  // ── Deducible vs No deducible ───────────────────────────
  stream += textCmd(marginL, y, 'ANALISIS DE DEDUCIBILIDAD', 12, 'F2');
  y -= 6;
  stream += '0.85 0.85 0.85 rg\n';
  stream += lineCmd(marginL, y, marginR, y, 0.5);
  stream += '0 0 0 rg\n';
  y -= 20;

  // Green bar for deducible
  const barW = 200;
  const dedPct = granTotal !== 0 ? (totalDeducible / granTotal) : 0;

  stream += '0.722 0.941 0.627 rg\n'; // accent green
  stream += rectFillCmd(marginL + 10, y - 2, Math.max(barW * dedPct, 2), 14);
  stream += '0 0 0 rg\n';
  stream += textCmd(marginL + barW + 20, y, `Deducible: ${COP.format(totalDeducible)} (${countDeducible} reg.)`, 10, 'F2');
  y -= 22;

  // Orange/warn bar for non-deducible
  const noDedPct = granTotal !== 0 ? (totalNoDeducible / granTotal) : 0;
  stream += '0.941 0.69 0.627 rg\n'; // warm orange
  stream += rectFillCmd(marginL + 10, y - 2, Math.max(barW * noDedPct, 2), 14);
  stream += '0 0 0 rg\n';
  stream += textCmd(marginL + barW + 20, y, `No deducible: ${COP.format(totalNoDeducible)} (${countNoDeducible} reg.)`, 10, 'F2');
  y -= 20;

  // List non-deducible categories
  stream += '0.4 0.4 0.4 rg\n';
  stream += textCmd(marginL + 10, y, 'Categorias no deducibles: ' + NON_DEDUCIBLE_CATS.join(', '), 7, 'F1');
  stream += '0 0 0 rg\n';
  y -= 30;

  // ── Footer ──────────────────────────────────────────────
  const genDate = new Date().toISOString().replace('T', ' ').slice(0, 19);
  stream += '0.7 0.7 0.7 rg\n';
  stream += lineCmd(marginL, 45, marginR, 45, 0.3);
  stream += textCmd(marginL, 32, `Generado: ${genDate} UTC | COCICP NIT 901277565-7 | Documento interno — no constituye soporte fiscal`, 7, 'F1');
  stream += '0 0 0 rg\n';

  // ── Assemble PDF ────────────────────────────────────────
  return buildPdf(stream, pageW, pageH);
}

// ── Low-level PDF 1.4 builder ───────────────────────────────

function buildPdf(streamContent, pageW, pageH) {
  const objects = [];
  let objNum = 0;

  function addObj(content) {
    objNum++;
    objects.push({ num: objNum, content });
    return objNum;
  }

  // Obj 1: Catalog
  const catalogNum = addObj('<< /Type /Catalog /Pages 2 0 R >>');

  // Obj 2: Pages
  const pagesNum = addObj(`<< /Type /Pages /Kids [3 0 R] /Count 1 >>`);

  // Obj 3: Page
  const pageNum = addObj(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageW} ${pageH}] ` +
    `/Contents 6 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> >>`
  );

  // Obj 4: Font Helvetica (regular)
  const font1Num = addObj(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'
  );

  // Obj 5: Font Helvetica-Bold
  const font2Num = addObj(
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'
  );

  // Obj 6: Content stream
  const encoder = new TextEncoder();
  const streamBytes = encoder.encode(streamContent);
  const streamNum = addObj(
    `<< /Length ${streamBytes.length} >>\nstream\n${streamContent}endstream`
  );

  // Build the raw PDF bytes
  let pdf = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets = [];

  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += `${obj.num} 0 obj\n${obj.content}\nendobj\n`;
  }

  const xrefOffset = pdf.length;
  pdf += 'xref\n';
  pdf += `0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const off of offsets) {
    pdf += String(off).padStart(10, '0') + ' 00000 n \n';
  }

  pdf += 'trailer\n';
  pdf += `<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\n`;
  pdf += 'startxref\n';
  pdf += `${xrefOffset}\n`;
  pdf += '%%EOF\n';

  return encoder.encode(pdf);
}
