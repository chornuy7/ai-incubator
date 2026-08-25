// Прелоад для тестов: гарантирует файловый бэкенд, а не Supabase.
// .env (с DATA_BACKEND=supabase) не должен утекать в тесты — они на изолированных
// файлах. Выставляем ПУСТО до любых импортов; dotenv не перезаписывает заданную
// переменную, поэтому значение из .env её не поднимет.
process.env.DATA_BACKEND = ''

/*
 * Свой каталог данных на прогон.
 *
 * Без этого тесты писали задачи и настройки в боевой `server/data`: в дашборде копились
 * задачи с `acc_test_1`, появлялись папки-призраки `ggr_progress_test` и `fatal_test`,
 * а при разборе живых логов их приходилось отфильтровывать глазами. Выставляем ДО любых
 * импортов — `DATA_DIR` вычисляется один раз при загрузке jsonStore.
 */
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const dir = path.join(os.tmpdir(), `ai-incubator-tests-${process.pid}-${Date.now().toString(36)}`)
fs.mkdirSync(dir, { recursive: true })
process.env.DATA_DIR = dir
