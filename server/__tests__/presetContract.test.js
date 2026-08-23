/**
 * Шаблон настроек обязан носить то, что модуль объявил своими параметрами.
 *
 * Созвон 19.08: «сохранил шаблон — настройки слетают; параметры не применяются или
 * применяются не так». Причина не в одном поле, а в устройстве: и СБОРКА настроек
 * (buildSettings), и ВОССТАНОВЛЕНИЕ из шаблона (applyPreset) — два списка, написанных
 * руками. Добавили поле в модуль, забыли дописать в один из них — шаблон молча теряет
 * его, и человек видит «слетевшие настройки» без единой ошибки.
 *
 * Тест фиксирует ТЕКУЩЕЕ состояние: известные пробелы перечислены ниже и это долг, а не
 * норма. Новые поля мимо шаблона добавить уже не получится — тест станет красным.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { DESCRIPTORS } from '../mcp/descriptors/index.js'

/**
 * Ситуативное — в шаблон не идёт осознанно: аккаунты и цели выбирают под конкретный
 * запуск, цель/кампания/агент живут своей жизнью, срок задаётся при постановке задачи.
 */
const SITUATIONAL = new Set(['accountIds', 'channels', 'targets', 'postUrls', 'deadline', 'goalId', 'campaignId', 'agentId'])

/** Долг: объявлено модулем, но шаблон этого не носит. Список должен только уменьшаться. */
const KNOWN_GAPS = new Set([
  // Нейромодули
  'semanticFilter', 'semanticThreshold', 'maxComments', 'minComments', 'promptText',
  'replyScope', 'replyLimitMode', 'maxRepliesPerLead', 'followUp', 'dialogGoal',
  'threads', 'allowLowTrust',
  // Парсеры: у них своя пачка настроек, и шаблон не носит ни одной.
  'endings', 'intersect', 'minMembers', 'maxMembers', 'commentFilter', 'alreadyParsed',
  'resultLimit', 'parallelAccounts', 'filters', 'limits', 'delayChat', 'delayItem',
  'intersectionMode', 'intersectionMin',
])

const read = async (p) => fs.readFile(new URL(p, import.meta.url), 'utf8')

test('шаблон восстанавливает параметры модулей — новые поля мимо него не добавить', async () => {
  const src = await read('../../src/features/modules/LiveModule.tsx')
  const from = src.indexOf('const applyPreset')
  assert.ok(from > 0, 'applyPreset на месте — иначе тест сторожит пустоту')
  const body = src.slice(from, src.indexOf('}, [', from))

  // Только модули, которые реально рисуются этим компонентом: у рассылки, автопостинга
  // и служебных задач свои экраны, и шаблон LiveModule к ним отношения не имеет.
  const cfgSrc = await read('../../src/shared/config/modules.ts')
  const at = cfgSrc.indexOf('export const MODULES')
  const live = new Set([...cfgSrc.slice(at).matchAll(/^ {2}'?([a-z-]+)'?:\s*\{/gm)].map((m) => m[1]))
  assert.ok(live.size > 5, 'список модулей прочитан — иначе тест ничего не проверяет')

  const missing = []
  for (const d of Object.values(DESCRIPTORS)) {
    if (!live.has(d.key)) continue
    for (const p of d.params || []) {
      const key = p.key || p.name
      if (!key || SITUATIONAL.has(key) || KNOWN_GAPS.has(key)) continue
      if (!body.includes(`s.${key}`)) missing.push(`${d.key}.${key}`)
    }
  }
  assert.deepEqual(missing, [], `эти параметры модуль объявил, но шаблон их не восстанавливает: ${missing.join(', ')}`)
})

test('список известных пробелов не разрастается', () => {
  // Цифра здесь — не догма, а тормоз: растёт список — значит долг растёт молча.
  assert.ok(KNOWN_GAPS.size <= 26, `известных пробелов стало больше (${KNOWN_GAPS.size}) — их надо закрывать, а не пополнять`)
})
