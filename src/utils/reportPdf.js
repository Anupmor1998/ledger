const PDFDocument = require("pdfkit");

const META_FILL = "#d9d9d9";
const BORDER_COLOR = "#444444";
const TEXT_COLOR = "#111111";
const FONT_LATIN_REGULAR =
  require.resolve("@fontsource/noto-sans/files/noto-sans-latin-400-normal.woff");
const FONT_LATIN_BOLD =
  require.resolve("@fontsource/noto-sans/files/noto-sans-latin-700-normal.woff");
const FONT_DEVANAGARI_REGULAR =
  require.resolve("@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-400-normal.woff");
const FONT_DEVANAGARI_BOLD =
  require.resolve("@fontsource/noto-sans-devanagari/files/noto-sans-devanagari-devanagari-700-normal.woff");
const FONT_GUJARATI_REGULAR =
  require.resolve("@fontsource/noto-sans-gujarati/files/noto-sans-gujarati-gujarati-400-normal.woff");
const FONT_GUJARATI_BOLD =
  require.resolve("@fontsource/noto-sans-gujarati/files/noto-sans-gujarati-gujarati-700-normal.woff");

function resolveWidth(columns, availableWidth) {
  const totalWeight =
    columns.reduce((sum, column) => sum + Number(column.width || 18), 0) || 1;
  return columns.map((column) => ({
    ...column,
    pdfWidth: (availableWidth * Number(column.width || 18)) / totalWeight,
  }));
}

function cellText(value) {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getFontName(bold = false) {
  return bold ? "ReportBold" : "ReportRegular";
}

function getScript(char) {
  if (/[\p{Script=Devanagari}]/u.test(char)) {
    return "devanagari";
  }
  if (/[\p{Script=Gujarati}]/u.test(char)) {
    return "gujarati";
  }
  if (/[\p{Script=Latin}]/u.test(char) || /[0-9]/.test(char)) {
    return "latin";
  }
  if (/\s/.test(char) || /[!-/:-@[-`{-~]/.test(char)) {
    return "common";
  }
  return "latin";
}

function getFontForScript(script, bold = false) {
  if (script === "devanagari") {
    return bold ? "ReportDevanagariBold" : "ReportDevanagariRegular";
  }
  if (script === "gujarati") {
    return bold ? "ReportGujaratiBold" : "ReportGujaratiRegular";
  }
  return bold ? "ReportLatinBold" : "ReportLatinRegular";
}

function splitTextRuns(text) {
  const safeText = cellText(text);
  if (!safeText) {
    return [];
  }

  const runs = [];
  let currentScript = "latin";
  let buffer = "";

  for (const char of safeText) {
    const script = getScript(char);
    const nextScript = script === "common" ? currentScript : script;

    if (!buffer) {
      buffer = char;
      currentScript = nextScript;
      continue;
    }

    if (nextScript === currentScript) {
      buffer += char;
      continue;
    }

    runs.push({ text: buffer, script: currentScript });
    buffer = char;
    currentScript = nextScript;
  }

  if (buffer) {
    runs.push({ text: buffer, script: currentScript });
  }

  return runs;
}

function drawRichText(doc, text, options = {}) {
  const runs = splitTextRuns(text);
  if (runs.length === 0) {
    return;
  }

  const x = options.x ?? doc.x;
  const y = options.y ?? doc.y;
  const width = options.width;
  const align = options.align || "left";
  const fontSize = options.fontSize || 10;
  const bold = Boolean(options.bold);

  runs.forEach((run, index) => {
    const fontName = getFontForScript(run.script, bold);
    doc.font(fontName).fontSize(fontSize);

    if (index === 0) {
      doc.text(run.text, x, y, {
        width,
        align,
        continued: runs.length > 1,
      });
      return;
    }

    doc.text(run.text, {
      continued: index < runs.length - 1,
    });
  });
}

function getLineValue(line) {
  if (typeof line === "object" && line !== null) {
    return line.value ?? "";
  }
  return line ?? "";
}

function ensurePageSpace(doc, requiredHeight, onPageBreak) {
  const bottomY = doc.page.height - doc.page.margins.bottom;
  if (doc.y + requiredHeight <= bottomY) {
    return;
  }
  doc.addPage();
  if (typeof onPageBreak === "function") {
    onPageBreak();
  }
}

function drawMergedRow(doc, text, options = {}, totalWidth) {
  const padding = 6;
  const fontSize = options.fontSize || 11;
  const height = options.height || 22;
  ensurePageSpace(doc, height);

  const startX = doc.page.margins.left;
  const startY = doc.y;
  doc.save();
  doc
    .rect(startX, startY, totalWidth, height)
    .fillAndStroke(META_FILL, META_FILL);
  doc.restore();

  doc.fillColor(TEXT_COLOR);
  drawRichText(doc, text, {
    x: startX + padding,
    y: startY + 4,
    width: totalWidth - padding * 2,
    align: options.alignment || "left",
    fontSize,
    bold: Boolean(options.bold),
  });

  doc.y = startY + height;
}

function drawTableHeader(doc, columns, widths) {
  const height = 20;
  ensurePageSpace(doc, height);
  const startX = doc.page.margins.left;
  const startY = doc.y;

  doc.save();
  doc
    .rect(
      startX,
      startY,
      widths.reduce((sum, width) => sum + width, 0),
      height,
    )
    .fillAndStroke("#ffffff", BORDER_COLOR);
  doc.restore();

  let cursorX = startX;
  columns.forEach((column, index) => {
    const width = widths[index];
    doc.fillColor(TEXT_COLOR);
    drawRichText(doc, column.header, {
      x: cursorX + 4,
      y: startY + 4,
      width: width - 8,
      align: "left",
      fontSize: 10,
      bold: true,
    });
    doc.rect(cursorX, startY, width, height).stroke(BORDER_COLOR);
    cursorX += width;
  });

  doc.y = startY + height;
}

function drawDataRow(doc, columns, widths, row) {
  const padding = 4;
  const isHighlighted = Boolean(row?.__highlight);
  const fill = isHighlighted ? META_FILL : "#ffffff";
  const texts = columns.map((column) => cellText(row?.[column.key] ?? ""));
  const heights = texts.map((text, index) =>
    doc.heightOfString(text, {
      width: Math.max(widths[index] - padding * 2, 20),
      fontSize: 10,
      align: "left",
    }),
  );
  const rowHeight = Math.max(18, ...heights.map((value) => value + 8));

  ensurePageSpace(doc, rowHeight, () => {
    drawTableHeader(doc, columns, widths);
  });

  const startX = doc.page.margins.left;
  const startY = doc.y;
  let cursorX = startX;

  columns.forEach((column, index) => {
    const width = widths[index];
    doc.save();
    doc
      .rect(cursorX, startY, width, rowHeight)
      .fillAndStroke(fill, BORDER_COLOR);
    doc.restore();

    doc.fillColor(TEXT_COLOR);
    drawRichText(doc, texts[index], {
      x: cursorX + padding,
      y: startY + 4,
      width: width - padding * 2,
      align: "left",
      fontSize: 10,
      bold: isHighlighted,
    });

    cursorX += width;
  });

  doc.y = startY + rowHeight;
}

function drawFooterLine(doc, text, totalWidth) {
  drawMergedRow(
    doc,
    text,
    { alignment: "center", bold: true, fontSize: 11, height: 18 },
    totalWidth,
  );
}

function renderSheet(doc, sheetConfig) {
  const columns = Array.isArray(sheetConfig.columns) ? sheetConfig.columns : [];
  const sections = Array.isArray(sheetConfig.sections)
    ? sheetConfig.sections
    : [];
  const headerLines = Array.isArray(sheetConfig.headerLines)
    ? sheetConfig.headerLines
    : [];
  const totalWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const widths = resolveWidth(columns, totalWidth).map(
    (column) => column.pdfWidth,
  );

  headerLines.forEach((line) =>
    drawMergedRow(doc, getLineValue(line), line || {}, totalWidth),
  );

  if (headerLines.length > 0) {
    doc.moveDown(0.5);
  }

  if (sections.length > 0) {
    sections.forEach((section, sectionIndex) => {
      if (sectionIndex > 0) {
        doc.moveDown(0.5);
      }

      const sectionHeaderLines = Array.isArray(section.headerLines)
        ? section.headerLines
        : [];
      const sectionColumns =
        Array.isArray(section.columns) && section.columns.length > 0
          ? section.columns
          : columns;
      const sectionWidths = resolveWidth(sectionColumns, totalWidth).map(
        (column) => column.pdfWidth,
      );
      const sectionRows = Array.isArray(section.rows) ? section.rows : [];
      const showHeader = section.showHeader !== false;
      const footerLines = Array.isArray(section.footerLines)
        ? section.footerLines
        : [];

      sectionHeaderLines.forEach((line) =>
        drawMergedRow(doc, getLineValue(line), line || {}, totalWidth),
      );

      if (showHeader && sectionColumns.length > 0) {
        drawTableHeader(doc, sectionColumns, sectionWidths);
      }

      sectionRows.forEach((row) => {
        drawDataRow(doc, sectionColumns, sectionWidths, row);
      });

      footerLines.forEach((line) =>
        drawFooterLine(doc, getLineValue(line), totalWidth),
      );
    });
  } else {
    if (columns.length > 0) {
      drawTableHeader(doc, columns, widths);
    }
    const rows = Array.isArray(sheetConfig.rows) ? sheetConfig.rows : [];
    rows.forEach((row) => {
      drawDataRow(doc, columns, widths, row);
    });
  }
}

async function sendPdfReport(res, fileName, sheets) {
  const doc = new PDFDocument({
    size: "A4",
    layout: "landscape",
    margin: 28,
    bufferPages: true,
    autoFirstPage: true,
  });

  doc.registerFont("ReportLatinRegular", FONT_LATIN_REGULAR);
  doc.registerFont("ReportLatinBold", FONT_LATIN_BOLD);
  doc.registerFont("ReportDevanagariRegular", FONT_DEVANAGARI_REGULAR);
  doc.registerFont("ReportDevanagariBold", FONT_DEVANAGARI_BOLD);
  doc.registerFont("ReportGujaratiRegular", FONT_GUJARATI_REGULAR);
  doc.registerFont("ReportGujaratiBold", FONT_GUJARATI_BOLD);

  const chunks = [];
  const pdfBuffer = await new Promise((resolve, reject) => {
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    sheets.forEach((sheet) => {
      renderSheet(doc, sheet);
      if (sheets[sheets.length - 1] !== sheet) {
        doc.addPage();
      }
    });

    doc.end();
  });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.end(pdfBuffer);
}

module.exports = {
  sendPdfReport,
};
