'use strict';

// Spreadsheet formula injection: a cell starting with = + - @ or a tab/CR can
// run as a formula in Excel or Sheets, so it is prefixed with an apostrophe.
const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (FORMULA_START.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

module.exports = { csvCell, toCsv };
