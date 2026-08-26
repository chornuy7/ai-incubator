/**
 * ПЕРЕНОС ШАБЛОНОВ НАСТРОЕК ИЗ ФАЙЛОВ В БАЗУ — разово и осознанно.
 *
 * Зачем отдельный запуск, а не автоперенос при первом чтении. Локальные копии
 * разработчиков ходят в ту же боевую базу, а файлы шаблонов у всех разные. При
 * автопереносе выигрывал бы тот, чья копия прочитала первой: его шаблоны уехали бы в прод,
 * а настоящие серверные — уже нет, потому что таблица непустая и перенос «сделан».
 * Поэтому переносим руками и ТАМ, где лежат настоящие файлы, — на сервере.
 *
 *   node server/scripts/presets-to-db.mjs           показать, что будет перенесено
 *   node server/scripts/presets-to-db.mjs --apply   перенести
 *
 * Если SSH нет — то же самое делает кнопка в админке (POST /api/admin/presets-to-db):
 * логика у них общая, `migratePresetFilesToDb`.
 *
 * Идемпотентно: модуль, по которому в базе уже есть шаблоны, пропускается. Файлы не
 * трогаются — они остаются точкой отката.
 */
import 'dotenv/config'
import { supabaseEnabled } from '../lib/supabase.js'
import { migratePresetFilesToDb } from '../modulePresets.js'

const APPLY = process.argv.includes('--apply')

if (!supabaseEnabled()) {
  console.error('DATA_BACKEND не supabase — переносить некуда. Запускать на сервере, где включена база.')
  process.exit(1)
}

const { moved, items } = await migratePresetFilesToDb({ apply: APPLY })
for (const it of items) {
  if (it.error) console.error(`ОШИБКА     ${it.moduleKey}: ${it.error}`)
  else if (it.skipped) console.log(`ПРОПУСК    ${it.moduleKey}: в базе уже ${it.count} шаблон(ов) — не трогаю`)
  else console.log(`${APPLY ? 'ПЕРЕНЕСЕНО' : 'ПЕРЕНЁС БЫ'} ${it.moduleKey}: ${it.count} — ${it.names.join(', ')}`)
}

console.log(`\nИТОГ: ${APPLY ? 'перенесено' : 'будет перенесено'} ${moved}, пропущено модулей ${items.filter((i) => i.skipped).length}`)
if (!APPLY) console.log('Это был показ. Чтобы перенести: node server/scripts/presets-to-db.mjs --apply')
