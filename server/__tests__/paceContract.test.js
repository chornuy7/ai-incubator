/**
 * Панель обещает время, воркер его отрабатывает — считать они обязаны одинаково.
 *
 * Созвон 19.08: «разрыв по таймингам». Множители темпа лежат в двух файлах (сервер и
 * фронт не делят код), и разъехаться им ничего не мешает: разойдутся — ETA и «полное
 * время» снова начнут врать, молча и без единой ошибки.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { delayMultiplier, pickDelay } from '../lib/protection.js'

const read = async (p) => fs.readFile(new URL(`../../${p}`, import.meta.url), 'utf8')
const arr = (src, name) => {
  const at = src.indexOf(`${name} = [`)
  assert.ok(at > 0, `${name} найден — иначе тест сторожит пустоту`)
  const from = src.indexOf('[', at)
  return JSON.parse(src.slice(from, src.indexOf(']', from) + 1))
}

test('множители темпа на фронте совпадают с серверными', async () => {
  const srv = await read('server/lib/protection.js')
  const web = await read('src/shared/lib/pace.ts')
  assert.deepEqual(arr(web, 'LEVEL_MUL'), arr(srv, 'LEVEL_MUL'), 'LEVEL_MUL разъехался')
  // На фронте есть 4-й пресет Custom (×1); сервер отдаёт ту же единицу через `?? 1`.
  assert.deepEqual(arr(web, 'PRESET_MUL').slice(0, 3), arr(srv, 'PRESET_MUL'), 'PRESET_MUL разъехался')
  assert.equal(arr(web, 'PRESET_MUL')[3], 1, 'Custom обязан быть ×1 — иначе он масштабирует заданные вручную задержки')
})

test('сервер множит уровень на пресет — ETA обязан делать так же', () => {
  assert.equal(delayMultiplier(1, 1), 1)
  assert.equal(Number(delayMultiplier(0, 2).toFixed(3)), 3.24) // осторожный уровень × макс. пресет
  assert.equal(delayMultiplier(1, 3), 1) // Custom
})

test('заданные тайминги исполняются как заданы — без пересчёта вправо-влево', () => {
  // Созвон 19.08: «задача должна исполняться строго с заданными таймингами».
  const [lo, hi] = [30, 120]
  const mul = delayMultiplier(1, 2) // сбалансированный уровень × максимальные задержки
  for (let i = 0; i < 200; i++) {
    const v = pickDelay(lo, hi, mul)
    assert.ok(v >= Math.round(lo * mul) && v <= Math.round(hi * mul), `пауза ${v} вне заданного диапазона`)
  }
  // Ровно это число панель и карточка обещают оператору: среднее по тому же множителю.
  assert.equal(((lo + hi) / 2) * mul, 135)
})

test('Custom не масштабирует — введённые вручную задержки уходят как есть', () => {
  const mul = delayMultiplier(1, 3)
  assert.equal(mul, 1)
  for (let i = 0; i < 50; i++) {
    const v = pickDelay(45, 45, mul)
    assert.equal(v, 45, 'ручное значение обязано доехать до воркера нетронутым')
  }
})

test('время задачи считается ОДНОЙ формулой — верх и низ панели не могут разойтись', async () => {
  // Созвон 24.08: вверху «25 мин», внизу «13 мин» для одного и того же запуска.
  const web = await read('src/shared/lib/pace.ts')
  assert.match(web, /export function taskSeconds/, 'общий расчёт времени на месте')
  for (const f of ['src/features/modules/shared/TimingSection.tsx', 'src/features/modules/shared/LaunchCost.tsx']) {
    const src = await read(f)
    assert.match(src, /taskSeconds/, `${f}: время считается общей формулой, а не своей`)
  }
})

test('доля аккаунта на фронте считается так же, как её делит воркер', async () => {
  // Тест гоняет node, а pace.ts — TypeScript, импортировать его отсюда нельзя. Поэтому
  // сверяем сами формулы: обе обязаны делить общую цель на число аккаунтов вверх.
  const web = await read('src/shared/lib/pace.ts')
  const srv = await read('server/lib/targets.js')
  assert.match(web, /Math\.ceil\(total \/ acc\)/, 'фронт: доля = ceil(общая / аккаунты)')
  assert.match(srv, /Math\.ceil\(resolveTotalTarget\(settings, task\) \/ accounts\)/, 'воркер: доля = ceil(общая / аккаунты)')
  // И общее время — это цепочка ОДНОГО аккаунта: доля × средняя пауза.
  assert.match(web, /Math\.ceil\(total \/ acc\) \* delay/, 'время = доля аккаунта × пауза')
})

test('все места, где показывается время задачи, зовут общую формулу', async () => {
  // Созвон 24.08: «главное, чтобы всюду показывалось верное время». Мест три:
  // блок «Защита и тайминги», нижняя панель запуска и ETA в дашборде задач.
  for (const f of [
    'src/features/modules/shared/TimingSection.tsx',
    'src/features/modules/shared/LaunchCost.tsx',
    'src/pages/TasksPage.tsx',
    'src/features/modules/LiveModule.tsx',
  ]) {
    const src = await read(f)
    assert.match(src, /taskSeconds|perAccountShare/, `${f}: время считается общей формулой`)
  }
})
