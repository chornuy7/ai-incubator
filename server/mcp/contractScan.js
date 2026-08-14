/**
 * Сканер обращений к настройкам задачи в исходниках.
 *
 * Единственная задача: узнать, какие ключи `settings` РЕАЛЬНО читает код модуля, и дать
 * contract-тесту сверить их с дескриптором. Это техническая замена дисциплине — добавил
 * поле в воркер, забыл про MCP, и тест краснеет, а не заказчик через две недели.
 *
 * Разбор намеренно текстовый, без AST: нужен список имён, а не семантика. Цена такого
 * решения — сканер видит только те функции, которые перечислены в `contract.sources`
 * дескриптора; читает код модуля в новом месте — это место надо туда добавить.
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'

/**
 * Вырезать тело функции по имени: от сигнатуры до парной закрывающей скобки.
 * @returns {string} тело или '' если символ не найден
 */
export function extractFunctionBody(source, symbol) {
  // export / export default / async — в любых сочетаниях перед function.
  const sig = new RegExp(`(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${symbol}\\s*\\(`)
  const m = sig.exec(source)
  if (!m) return ''

  // Сначала пропускаем список аргументов целиком. Наивный поиск первой `{` после
  // сигнатуры находил значение по умолчанию (`function f(settings, seed = {})`) и
  // возвращал пустое тело — а пустое тело тест читает как «поле нигде не читается».
  const parenStart = m.index + m[0].length - 1
  let parens = 0
  let parenEnd = -1
  for (let i = parenStart; i < source.length; i += 1) {
    if (source[i] === '(') parens += 1
    else if (source[i] === ')') {
      parens -= 1
      if (parens === 0) { parenEnd = i; break }
    }
  }
  if (parenEnd < 0) return ''

  const open = source.indexOf('{', parenEnd)
  if (open < 0) return ''

  let depth = 0
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open + 1, i)
    }
  }
  return source.slice(open + 1)
}

// Обращения вида `s.field`, `settings.field`, `settings?.field`, `task.settings.field`.
// Отрицательный lookbehind отсекает чужие объекты (`posts.filter`, `meta.status`).
const DIRECT = /(?<![\w$.])(?:s|settings)\s*\??\.\s*([A-Za-z_$][\w$]*)/g
const VIA_TASK = /task\s*\??\.\s*settings\s*\??\.\s*([A-Za-z_$][\w$]*)/g

/** Имена ключей настроек, встреченные в куске кода. */
export function scanSettingsKeys(code) {
  const out = new Set()
  for (const re of [DIRECT, VIA_TASK]) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(code)) !== null) out.add(m[1])
  }
  return out
}

/**
 * Пройти по `contract.sources` дескриптора и собрать все читаемые ключи.
 * @param {object} desc дескриптор модуля
 * @param {string} rootDir корень репозитория
 * @returns {Promise<{keys: Set<string>, missingSymbols: string[]}>}
 */
export async function scanDescriptorSources(desc, rootDir) {
  const keys = new Set()
  const missingSymbols = []
  for (const src of desc.contract?.sources || []) {
    const abs = path.join(rootDir, src.file)
    const code = await readFile(abs, 'utf8')
    for (const symbol of src.symbols) {
      const body = extractFunctionBody(code, symbol)
      // Функцию переименовали или удалили — источник правды указывает в пустоту.
      // Молчать здесь нельзя: тест решит, что читать нечего, и пропустит рассинхрон.
      if (!body) { missingSymbols.push(`${src.file}:${symbol}`); continue }
      for (const k of scanSettingsKeys(body)) keys.add(k)
    }
  }
  return { keys, missingSymbols }
}
