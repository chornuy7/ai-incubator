/**
 * MR-231/232/233 — раздел «Статистика» после созвона 30.08.
 *
 * Проверки текстовые: страница чисто фронтовая, а ломается в ней ровно то, что человек
 * замечает не сразу — файл экспорта не от того раздела, ID задачи не видно, кнопки не там.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

const src = fs.readFileSync(new URL('../../src/pages/StatisticsPage.tsx', import.meta.url), 'utf8')

test('MR-233: экспорт формирует файл по ОТКРЫТОМУ разделу', () => {
  // Владелец: «дашборд — дашборд, запуски — запуски, кошелёк — кошелёк».
  assert.match(src, /function exportMyCsv\(\s*\n?\s*stats: MyStats,\s*\n?\s*tab: string,/)
  const тело = src.slice(src.indexOf('function exportMyCsv'), src.indexOf('function DemoStatistics'))
  assert.match(тело, /tab === 'log'/)
  assert.match(тело, /tab === 'wallet'/)
  // Имя файла тоже своё: «my-stats.csv» из кошелька — это и был баг.
  for (const имя of ['my-tasks.csv', 'my-wallet.csv', 'my-stats.csv']) {
    assert.ok(тело.includes(имя), `нет отдельного файла ${имя}`)
  }
  // В выгрузке запусков есть ID задачи — по названию задачу не найти.
  assert.match(тело, /'ID задачи'/)
})

test('MR-233: значения с точкой с запятой не ломают столбцы', () => {
  // CSV разделён «;», и комментарий операции кошелька вполне может его содержать.
  const тело = src.slice(src.indexOf('function exportMyCsv'), src.indexOf('function DemoStatistics'))
  assert.match(тело, /replace\(\/"\/g, '""'\)/)
})

test('MR-232: ID задачи стоит перед названием и копируется по клику', () => {
  const блок = src.slice(src.indexOf('function LogTab'), src.indexOf('function WalletTab'))
  const idx = блок.indexOf('копировать(t.id)')
  assert.ok(idx > 0, 'ID не копируется')
  assert.ok(idx < блок.indexOf('{t.title}'), 'ID должен стоять ДО названия')
  assert.match(блок, /navigator\.clipboard\?\.writeText\(id\)/)
  // Клик по ID не должен заодно разворачивать строку.
  assert.match(блок, /e\.stopPropagation\(\)/)
})

test('MR-231: периоды и экспорт — в одном ряду с разделами, сверху только обновление и «?»', () => {
  const начало = src.indexOf('subtitle="Моя активность')
  // Шапка кончается там, где закрывается PageHeader, — иначе в срез попадёт и ряд ниже.
  const шапка = src.slice(начало, src.indexOf('/>', src.indexOf('</>}', начало)))
  assert.match(шапка, /HelpButton/)
  assert.match(шапка, /title="Обновить"/)
  assert.doesNotMatch(шапка, /exportBtn/, 'экспорт остался в шапке')
  // Разделы — такой же групповой кнопкой, как периоды.
  assert.match(src, /options=\{TABS\.map\(\(t\) => t\.label\)\}/)
  const ряд = src.slice(src.indexOf('options={TABS.map'), src.indexOf('{loading && !stats'))
  assert.match(ряд, /options=\{RANGES\}/)
  assert.match(ряд, /\{exportBtn\}/)
})

test('ключи разделов не изменились — ссылки на вкладки не ломаются', () => {
  const блок = src.slice(src.indexOf('const TABS = ['), src.indexOf(']', src.indexOf('const TABS = [')))
  for (const key of ['dashboard', 'log', 'wallet']) assert.ok(блок.includes(`'${key}'`), `пропал раздел ${key}`)
})
