/**
 * Гигиена исходников: в коде не должно быть управляющих байтов.
 *
 * Повод — реальный случай (MR-290). В accountGroups.js разделитель составного ключа
 * оказался записан НАСТОЯЩИМ байтом NUL вместо escape-последовательности. Код при этом
 * работал и все 1257 тестов были зелёными — а вот git diff показывал «Binary files
 * differ» вместо строк, и grep переставал находить в файле что бы то ни было. Файл
 * выпадал из ревью и из поиска, и заметить это можно было только случайно.
 *
 * Проверка дешёвая и ловит целый класс аварий: невидимые символы, попавшие в исходник
 * при копировании из чата, из PDF или из вывода другого инструмента.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL("../..", import.meta.url))
const DIRS = ['server', 'src', 'scripts', 'supabase']
const EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.sql', '.json'])
const SKIP_DIRS = new Set(['node_modules', 'data', 'dist', 'cache'])

/**
 * Управляющие символы, которых в исходнике быть не должно. Табуляция, перевод строки и
 * возврат каретки законны; остальной диапазон C0, а также DEL — нет.
 *
 * Записан через new RegExp со строкой, а не литералом: литерал с настоящими байтами
 * внутри сам стал бы тем, что этот тест ищет.
 */
const BAD = new RegExp('[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]')

/** @param {string} dir @returns {Promise<string[]>} */
async function walk(dir) {
  let entries
  try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...await walk(full))
    else if (EXT.has(path.extname(e.name))) out.push(full)
  }
  return out
}

test('в исходниках нет управляющих байтов', async () => {
  const files = (await Promise.all(DIRS.map((d) => walk(path.join(ROOT, d))))).flat()
  assert.ok(files.length > 100, `обход не нашёл исходников (${files.length}) — проверьте путь ${ROOT}`)

  const dirty = []
  for (const f of files) {
    const text = await fs.readFile(f, 'utf8')
    const at = text.search(BAD)
    if (at === -1) continue
    const line = text.slice(0, at).split(String.fromCharCode(10)).length
    const code = text.charCodeAt(at).toString(16).padStart(4, '0').toUpperCase()
    dirty.push(`${path.relative(ROOT, f)}:${line} — U+${code}`)
  }

  assert.deepEqual(dirty, [], [
    'В исходниках есть управляющие символы. Такой файл git считает бинарным:',
    'в ревью вместо строк будет «Binary files differ», а grep перестанет его находить.',
    'Замените байт на escape-последовательность:',
    ...dirty.map((d) => '  · ' + d),
  ].join(String.fromCharCode(10)))
})
