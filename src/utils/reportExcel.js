const ExcelJS = require("exceljs");

function autoSizeColumns(worksheet) {
  worksheet.columns.forEach((column) => {
    let maxLength = 10;
    column.eachCell({ includeEmpty: true }, (cell) => {
      const value = cell.value === null || cell.value === undefined ? "" : String(cell.value);
      maxLength = Math.max(maxLength, value.length + 2);
    });
    column.width = Math.min(maxLength, 40);
  });
}

function addSheet(workbook, name, columns, rows) {
  const worksheet = workbook.addWorksheet(name);
  worksheet.columns = columns.map((col) => ({ header: col.header, key: col.key }));
  rows.forEach((row) => worksheet.addRow(row));
  worksheet.getRow(1).font = { bold: true };
  autoSizeColumns(worksheet);
  return worksheet;
}

async function sendWorkbook(res, fileName, sheets) {
  const workbook = new ExcelJS.Workbook();
  sheets.forEach((sheet) => addSheet(workbook, sheet.name, sheet.columns, sheet.rows));

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
