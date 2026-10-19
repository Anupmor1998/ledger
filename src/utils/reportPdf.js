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

const COLUMN_FIXED_WIDTHS = {
  amount: 48,
  lot: 22,
  meter: 48,
  rate: 28,
  orderId: 34,
  date: 66,
  paymentStatus: 64,
};

function getColumnAlign(key) {
  if (key === "amount" || key === "lot" || key === "meter" || key === "rate") {
    return "right";
  }
  if (key === "date" || key === "paymentStatus" || key === "orderId") {
    return "center";
  }
  return "left";
}

function resolveWidth(columns, availableWidth) {
  if (!columns || columns.length === 0) return [];

  let fixedTotal = 0;
  let flexTotalWeight = 0;

  const colInfo = columns.map((col) => {
    const fixedWidth = COLUMN_FIXED_WIDTHS[col.key];
    if (fixedWidth !== undefined) {
      fixedTotal += fixedWidth;
      return { col, fixedWidth, isFlex: false };
    }
    const weight = Number(col.width || 20);
    flexTotalWeight += weight;
    return { col, weight, isFlex: true };
  });

  const remainingWidth = Math.max(availableWidth - fixedTotal, 0);

  let currentTotal = 0;
  const result = colInfo.map((info) => {
    let pdfWidth;
    if (info.isFlex) {
      if (flexTotalWeight > 0) {
        pdfWidth = (remainingWidth * info.weight) / flexTotalWeight;
      } else {
        pdfWidth = remainingWidth / colInfo.filter((c) => c.isFlex).length;
      }
    } else {
      if (fixedTotal > availableWidth && flexTotalWeight === 0) {
        pdfWidth = (availableWidth * info.fixedWidth) / fixedTotal;
      } else {
        pdfWidth = info.fixedWidth;
      }
    }
    currentTotal += pdfWidth;
    return {
      ...info.col,
      pdfWidth,
    };
  });

  if (result.length > 0) {
    const diff = availableWidth - currentTotal;
    result[result.length - 1].pdfWidth += diff;
  }

  return result;
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
  return bold ? "ReportLatinBold" : "ReportLatinRegular";
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
  const isPartyBlock = options.fill === true;
  const fontSize = isPartyBlock ? 8.5 : (options.fontSize || 10);
  const height = isPartyBlock ? 15 : (options.height || 18);
  ensurePageSpace(doc, height);

  const startX = doc.page.margins.left;
  const startY = doc.y;
  if (options.fill !== false && options.fill !== undefined) {
    doc.save();
    doc
      .rect(startX, startY, totalWidth, height)
      .fillAndStroke(META_FILL, META_FILL);
    doc.restore();
  }

  const yOffset = Math.max(Math.floor((height - fontSize) / 2), 2);

  doc.fillColor(TEXT_COLOR);
  drawRichText(doc, text, {
    x: startX + padding,
    y: startY + yOffset,
    width: totalWidth - padding * 2,
    align: options.alignment || "left",
    fontSize,
    bold: Boolean(options.bold),
  });

  doc.y = startY + height;
}

function drawTableHeader(doc, columns, widths) {
  const padding = 2;
  const fontSize = 7.5;
  const height = 18;

  ensurePageSpace(doc, height);
  const startX = doc.page.margins.left;
  const startY = doc.y;
  const totalWidth = widths.reduce((sum, width) => sum + width, 0);

  doc.save();
  doc
    .rect(startX, startY, totalWidth, height)
    .fillAndStroke("#f2f4f7", BORDER_COLOR);
  doc.restore();

  let cursorX = startX;
  const textY = startY + 4;

  columns.forEach((column, index) => {
    const width = widths[index];
    doc.fillColor(TEXT_COLOR);
    drawRichText(doc, column.header, {
      x: cursorX + padding,
      y: textY,
      width: width - padding * 2,
      align: "center",
      fontSize,
      bold: true,
    });

    if (index > 0) {
      doc.save();
      doc
        .strokeColor(BORDER_COLOR)
        .lineWidth(0.75)
        .moveTo(cursorX, startY)
        .lineTo(cursorX, startY + height)
        .stroke();
      doc.restore();
    }
    cursorX += width;
  });

  doc.y = startY + height;
}

function drawDataRow(doc, columns, widths, row) {
  if (row?.__isBanner) {
    const totalWidth = widths.reduce((sum, w) => sum + w, 0);
    drawMergedRow(
      doc,
      row.text,
      {
        alignment: "left",
        bold: true,
        fontSize: 8,
        height: 16,
        fill: false,
      },
      totalWidth,
    );
    return;
  }

  if (row?.__mergeRest) {
    const padding = 3;
    const fontSize = 7.5;
    const firstWidth = widths[0];
    const restWidth = widths.slice(1).reduce((sum, w) => sum + w, 0);

    doc.font(getFontName(false)).fontSize(fontSize);
    const detailsHeight = doc.heightOfString(cellText(row.details), {
      width: Math.max(restWidth - padding * 2, 20),
      lineGap: 1,
    });
    const rowHeight = Math.max(16, Math.ceil(detailsHeight) + 5);

    ensurePageSpace(doc, rowHeight, () => {
      drawTableHeader(doc, columns, widths);
    });

    const startX = doc.page.margins.left;
    const startY = doc.y;

    doc.fillColor(TEXT_COLOR);
    drawRichText(doc, cellText(row.amount), {
      x: startX + padding,
      y: startY + 3,
      width: firstWidth - padding * 2,
      align: "right",
      fontSize,
      bold: false,
    });

    if (restWidth > 0) {
      doc.fillColor(TEXT_COLOR);
      drawRichText(doc, cellText(row.details), {
        x: startX + firstWidth + padding,
        y: startY + 3,
        width: restWidth - padding * 2,
        align: "left",
        fontSize,
        bold: false,
      });
    }

    doc.y = startY + rowHeight;
    return;
  }

  const padding = 2;
  const fontSize = 7.5;
  const isHighlighted = Boolean(row?.__highlight);
  const isBold = Boolean(row?.__bold || row?.__highlight);
  const texts = columns.map((column) => cellText(row?.[column.key] ?? ""));

  doc.font(getFontName(isBold)).fontSize(fontSize);
  const heights = texts.map((text, index) =>
    doc.heightOfString(text, {
      width: Math.max(widths[index] - padding * 2, 10),
      lineGap: 1,
    }),
  );
  const rowHeight = Math.max(16, ...heights.map((value) => Math.ceil(value) + 5));

  ensurePageSpace(doc, rowHeight, () => {
    drawTableHeader(doc, columns, widths);
  });

  const startX = doc.page.margins.left;
  const startY = doc.y;
  const totalWidth = widths.reduce((sum, w) => sum + w, 0);

  if (isHighlighted) {
    doc.save();
    doc.rect(startX, startY, totalWidth, rowHeight).fill("#ebebeb");
    doc.restore();
  }

  let cursorX = startX;
  columns.forEach((column, index) => {
    const width = widths[index];
    const align = getColumnAlign(column.key);

    doc.fillColor(TEXT_COLOR);
    drawRichText(doc, texts[index], {
      x: cursorX + padding,
      y: startY + 3,
      width: width - padding * 2,
      align,
      fontSize,
      bold: isBold,
    });

    cursorX += width;
  });

  doc.y = startY + rowHeight;
}

function drawFooterLine(doc, line, totalWidth) {
  const text = getLineValue(line);
  const options = typeof line === "object" && line !== null ? line : {};
  if (typeof text === "string" && text.replace(/=/g, "").trim() === "") {
    ensurePageSpace(doc, 8);
    doc.y += 6;
    return;
  }
  drawMergedRow(
    doc,
    text,
    {
      alignment: options.alignment || "center",
      bold: options.bold !== undefined ? options.bold : true,
      fontSize: options.fontSize || 10,
      height: options.height || 18,
      fill: options.fill,
    },
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
      if (section.pageBreakBefore && sectionIndex > 0) {
        doc.addPage();
        if (Array.isArray(section.pageBreakHeaderLines) && section.pageBreakHeaderLines.length > 0) {
          section.pageBreakHeaderLines.forEach((line) =>
            drawMergedRow(doc, getLineValue(line), line || {}, totalWidth),
          );
          doc.moveDown(0.5);
        }
      } else if (sectionIndex > 0) {
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

      if (sectionHeaderLines.length > 0) {
        doc.y += 3;
      }

      if (showHeader && sectionColumns.length > 0) {
        drawTableHeader(doc, sectionColumns, sectionWidths);
      }

      sectionRows.forEach((row) => {
        drawDataRow(doc, sectionColumns, sectionWidths, row);
      });

      footerLines.forEach((line) =>
        drawFooterLine(doc, line, totalWidth),
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

async function sendPdfReport(res, fileName, sheets, options = {}) {
  const layout =
    String(options?.orientation || "portrait").toLowerCase() === "landscape"
      ? "landscape"
      : "portrait";
  const doc = new PDFDocument({
    size: "A4",
    layout,
    margin: 16,
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
  const encodedFileName = encodeURIComponent(fileName);
  const dispositionType =
    String(options?.disposition || "attachment").toLowerCase() === "inline"
      ? "inline"
      : "attachment";
  res.setHeader(
    "Content-Disposition",
    `${dispositionType}; filename="${fileName.replace(/"/g, '')}"; filename*=UTF-8''${encodedFileName}`
  );
  res.end(pdfBuffer);
}

module.exports = {
  sendPdfReport,
};
