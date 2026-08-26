/**
 * ПЕРЕНОС ШАБЛОНОВ НАСТРОЕК ИЗ ФАЙЛОВ В БАЗУ — разово и осознанно.
 *
 * Зачем отдельный скрипт, а не автоперенос при первом чтении. Локальные копии
 * разработчиков ходят в ту же боевую базу, а файлы шаблонов у всех разные. При
 * автопереносе выигрывал бы тот, чья копия прочитала первой: его шаблоны уехали бы в прод,
 * а настоящие серверные — уже нет, потому что таблица непустая и перенос «сделан».
 * Поэтому переносим руками и ТАМ, где лежат настоящие файлы, — на сервере.
 *
 *   node server/scripts/presets-to-db.mjs           показать, что будет перенесено
 *   node server/scripts/presets-to-db.mjs --apply   перенести
 *
 * Идемпотентно: модуль, по которому в базе уже есть шаблоны, пропускается — повторный
 * запуск не воскресит удалённое и не создаст дублей. Файлы не трогаются: они остаются
 * точкой отката.
 */
import 'dotenv/config'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DATA_DIR } from '../lib/jsonStore.js'
import { supabaseEnabled } from '../lib/supabase.js'
import { loadModulePresets, saveModulePresets } from '../modulePresets.js'

const APPLY = process.argv.includes('--apply')

if (!supabaseEnabled()) {
  console.error('DATA_BACKEND не supabase — переносить некуда. Запускать на сервере, где включена база.')
  process.exit(1)
}

/** Где лежат файлы шаблонов: общий стор модулей + отдельный у нейрокомментинга. */
async function sources() {
  const out = []
  const modulesDir = path.join(DATA_DIR, 'modules')
  const dirs = await fs.readdir(modulesDir, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    out.push({ moduleKey: d.name, file: path.join(modulesDir, d.name, 'presets.json') })
  }
  // Нейрокомментинг исторически живёт в своём каталоге, а не в modules/.
  out.push({ moduleKey: 'neuro-commenting', file: path.join(DATA_DIR, 'neuro-commenting', 'presets.json') })
  return out
}

const readFilePresets = async (file) => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { return [] }
}

let moved = 0
let skipped = 0
for (const { moduleKey, file } of await sources()) {
  const fromFile = await readFilePresets(file)
  if (!Array.isArray(fromFile) || !fromFile.length) continue

  const inDb = await loadModulePresets(moduleKey).catch((e) => {
    console.error(`  ${moduleKey}: не удалось прочитать базу — ${e.message}`)
    return null
  })
  if (inDb === null) continue
  if (inDb.length) {
    console.log(`ПРОПУСК  ${moduleKey}: в базе уже ${inDb.length} шаблон(ов) — не трогаю`)
    skipped += 1
    continue
  }

  const names = fromFile.map((p) => p.name).join(', ')
  if (!APPLY) {
    console.log(`ПЕРЕНЁС БЫ  ${moduleKey}: ${fromFile.length} — ${names}`)
    moved += fromFile.length
    continue
  }
  await saveModulePresets(moduleKey, fromFile)
  const check = await loadModulePresets(moduleKey)
  console.log(`ПЕРЕНЕСЕНО  ${moduleKey}: ${check.length} из ${fromFile.length} — ${names}`)
  moved += check.length
}

console.log(`\nИТОГ: ${APPLY ? 'перенесено' : 'будет перенесено'} ${moved}, пропущено модулей ${skipped}`)
if (!APPLY) console.log('Это был показ. Чтобы перенести: node server/scripts/presets-to-db.mjs --apply')
