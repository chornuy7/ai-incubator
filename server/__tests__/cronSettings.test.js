/**
 * Настройки фоновых задач (просьба владельца 26.08: «в админку вынести все настройки по
 * кроне»). Значения приходят из формы, то есть от человека, — поэтому главное здесь не
 * «сохранилось ли», а что мусор не доедет до планировщика: интервал в ноль минут превратит
 * тик в бесконечный цикл, а отрицательный период заставит ревизию идти без остановки.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'

process.env.DATA_DIR = path.join(os.tmpdir(), `cron-${process.pid}-${Math.random().toString(36).slice(2)}`)
const { CRON_FIELDS, getCronSettings, setCronSettings, getCronSync } = await import('../cronSettings.js')

test('по умолчанию — те же значения, что были в коде', async () => {
  const v = await getCronSettings()
  assert.equal(v.parserPeriodH, 12, 'ревизия базы раз в 12 часов — решение владельца')
  assert.equal(v.parserParallel, 3, 'до трёх запросов одновременно')
  assert.equal(v.healthEveryH, 12)
  assert.equal(v.campaignTickMin, 1)
})

test('мусор из формы не доезжает до планировщика', async () => {
  const v = await setCronSettings({
    parserTickMin: 0,          // ноль — бесконечный тик
    parserParallel: 999,       // выгребет весь парк
    healthEveryH: -5,          // отрицательный период
    creditTickH: 'абракадабра',
  })
  const f = (k) => CRON_FIELDS.find((x) => x.key === k)
  assert.equal(v.parserTickMin, f('parserTickMin').min)
  assert.equal(v.parserParallel, f('parserParallel').max)
  assert.equal(v.healthEveryH, f('healthEveryH').min)
  assert.equal(v.creditTickH, f('creditTickH').def, 'нечисло — возвращаем умолчание, а не NaN')
})

test('чужие ключи игнорируются, свои сохраняются', async () => {
  const v = await setCronSettings({ parserPeriodH: 6, злоумышленник: 1 })
  assert.equal(v.parserPeriodH, 6)
  assert.ok(!('злоумышленник' in v))
  // Планировщики читают синхронно на каждом тике — правка должна быть видна сразу.
  assert.equal(getCronSync().parserPeriodH, 6)
})
