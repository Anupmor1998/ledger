const ExcelJS = require("exceljs");

const META_FILL = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFD9D9D9" },
};

function styleMetaCell(cell, options = {}) {
  const alignment = options.alignment || "left";
  const fontSize = options.fontSize || 11;
  const bold = options.bold ?? false;

  cell.font = { name: "Courier New", size: fontSize, bold };
  cell.alignment = { horizontal: alignment, vertical: "middle", wrapText: true };
  cell.fill = META_FILL;
}

function styleHeaderRow(row) {
  row.font = { name: "Courier New", size: 11, bold: true };
  row.alignment = { horizontal: "left", vertical: "middle" };
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.border = {
      bottom: { style: "thin" },
    };
  });
}

function writeMergedMetaRow(worksheet, rowIndex, totalColumns, line) {
  const value = typeof line === "object" && line !== null ? line.value : line;
  const options = typeof line === "object" && line !== null ? line : {};
  worksheet.mergeCells(rowIndex, 1, rowIndex, totalColumns);
  for (let colIndex = 1; colIndex <= totalColumns; colIndex += 1) {
    styleMetaCell(worksheet.getCell(rowIndex, colIndex), options);
  }
  worksheet.getCell(rowIndex, 1).value = value;
  worksheet.getRow(rowIndex).height = options.height || 22;
}

function writeTableHeaderRow(worksheet, rowIndex, columns) {
  const headerRow = worksheet.getRow(rowIndex);
  columns.forEach((col, index) => {
    const cell = headerRow.getCell(index + 1);
    cell.value = col.header;
    cell.font = { name: "Courier New", size: 11, bold: true };
    cell.alignment = { horizontal: "left", vertical: "middle" };
    cell.border = {
      bottom: { style: "thin" },
    };
  });
}

function styleDataCell(cell, options = {}) {
  const bold = options.bold ?? false;
  cell.font = { name: "Courier New", size: 11, bold };
  cell.alignment = { horizontal: "left", vertical: "middle" };
  if (options.highlight) {
    cell.fill = META_FILL;
  }
}

function addSheet(workbook, sheetConfig) {
  const worksheet = workbook.addWorksheet(sheetConfig.name);
  const columns = Array.isArray(sheetConfig.columns) ? sheetConfig.columns : [];
  const rows = Array.isArray(sheetConfig.rows) ? sheetConfig.rows : [];
  const sections = Array.isArray(sheetConfig.sections) ? sheetConfig.sections : [];
  const headerLines = Array.isArray(sheetConfig.headerLines) ? sheetConfig.headerLines : [];
  const totalColumns = Math.max(columns.length, 1);
  let currentRow = 1;

  worksheet.columns = columns.map((col) => ({
    key: col.key,
    width: col.width || 18,
  }));

  if (headerLines.length > 0) {
    headerLines.forEach((line) => {
      writeMergedMetaRow(worksheet, currentRow, totalColumns, line);
      currentRow += 1;
    });
    currentRow += 1;
  }

  if (columns.length > 0) {
    writeTableHeaderRow(worksheet, currentRow, columns);
    currentRow += 1;
  }

  if (sections.length > 0) {
    sections.forEach((section, sectionIndex) => {
      const sectionHeaderLines = Array.isArray(section.headerLines) ? section.headerLines : [];
      const sectionColumns = Array.isArray(section.columns) && section.columns.length > 0 ? section.columns : columns;
      const sectionRows = Array.isArray(section.rows) ? section.rows : [];
      const showHeader = section.showHeader !== false;
      const footerLines = Array.isArray(section.footerLines) ? section.footerLines : [];

      if (sectionIndex > 0) {
        currentRow += 1;
      }

      sectionHeaderLines.forEach((line) => {
        writeMergedMetaRow(worksheet, currentRow, totalColumns, line);
        currentRow += 1;
      });

      if (showHeader && sectionColumns.length > 0) {
        writeTableHeaderRow(worksheet, currentRow, sectionColumns);
        currentRow += 1;
      }

      sectionRows.forEach((row) => {
        const dataRow = worksheet.getRow(currentRow);
        const isHighlightedRow = Boolean(row?.__highlight);
        sectionColumns.forEach((col, index) => {
          dataRow.getCell(index + 1).value = row?.[col.key] ?? "";
          styleDataCell(dataRow.getCell(index + 1), {
            bold: isHighlightedRow,
            highlight: isHighlightedRow,
          });
        });
        if (isHighlightedRow) {
          dataRow.height = 20;
        }
        currentRow += 1;
      });

      footerLines.forEach((line) => {
        writeMergedMetaRow(worksheet, currentRow, totalColumns, line);
        currentRow += 1;
      });
    });
  } else {
    rows.forEach((row) => {
      const dataRow = worksheet.getRow(currentRow);
      const isHighlightedRow = Boolean(row?.__highlight);
      columns.forEach((col, index) => {
        dataRow.getCell(index + 1).value = row?.[col.key] ?? "";
        styleDataCell(dataRow.getCell(index + 1), {
          bold: isHighlightedRow,
          highlight: isHighlightedRow,
        });
      });
      if (isHighlightedRow) {
        dataRow.height = 20;
      }
      currentRow += 1;
    });
  }

  worksheet.views = [
    {
      state: "frozen",
      ySplit: Math.max(headerLines.length + (columns.length > 0 ? 2 : 0), 0),
    },
  ];

  return worksheet;
}

async function sendWorkbook(res, fileName, sheets) {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach((sheet) => addSheet(workbook, sheet));

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

  await workbook.xlsx.write(res);
  res.end();
}

module.exports = {
  sendWorkbook,
};
