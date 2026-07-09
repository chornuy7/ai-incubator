// Экспорт в Excel (.xls) без зависимостей — формат SpreadsheetML 2003 (XML).
// Открывается в Excel/LibreOffice/Google Sheets.

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function rowsToXls(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) => k !== 'entity')
  const cell = (v: unknown) => {
    const num = typeof v === 'number' && Number.isFinite(v)
    return `<Cell><Data ss:Type="${num ? 'Number' : 'String'}">${esc(v)}</Data></Cell>`
  }
  const head = `<Row>${cols.map((c) => `<Cell><Data ss:Type="String">${esc(c)}</Data></Cell>`).join('')}</Row>`
  const body = rows.map((r) => `<Row>${cols.map((c) => cell(r[c])).join('')}</Row>`).join('')
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>` +
    `<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">` +
    `<Worksheet ss:Name="Результаты"><Table>${head}${body}</Table></Worksheet></Workbook>`
}

export function downloadXls(rows: Record<string, unknown>[], filename: string, columns?: string[]) {
  const blob = new Blob([rowsToXls(rows, columns)], { type: 'application/vnd.ms-excel' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.xls') ? filename : `${filename}.xls`
  a.click()
  URL.revokeObjectURL(url)
}
