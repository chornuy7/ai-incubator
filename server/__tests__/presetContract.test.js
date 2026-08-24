/**
 * Шаблон настроек обязан носить то, что модуль объявил своими параметрами.
 *
 * Созвон 19.08: «сохранил шаблон — настройки слетают; параметры не применяются или
 * применяются не так». Причина не в одном поле, а в устройстве. Потерять настройку
 * можно двумя способами, и сторожим оба:
 *
 *  1. Забыли строку в `applyPreset` — у поля есть контрол, но шаблон его не выставляет.
 *     Ловим сверкой параметров модуля с телом applyPreset.
 *  2. Контрола нет вовсе — `buildSettings` собирает настройки заново из формы, и всё,
 *     чего форма не показывает, при запуске исчезает. Так теряются параметры MCP-задач
 *     (`delayPreset` у парсеров, `threads`/`typeWeights` у нейродиалогов). Ловим тем,
 *     что каждый модуль обязан подкладывать применённый шаблон (`usePresetCarry`).
 *
 * Модули рисуются РАЗНЫМИ компонентами, и у каждого свой applyPreset (см.
 * features/modules/index.tsx). Проверяем каждый против своего — иначе тест ловит
 * несуществующие пробелы: параметры парсеров восстанавливает парсерный компонент, а не
 * общий LiveModule.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { DESCRIPTORS } from '../mcp/descriptors/index.js'

/** Какой компонент рисует модуль — повторяет ModuleLiveRouter. */
const OWNER = {
  'neuro-dialogs': 'src/features/neuro-dialogs/NeuroDialogsModule.tsx',
  parsing: 'src/features/modules/ChannelParserModule.tsx',
  'parsing-groups': 'src/features/modules/ChannelParserModule.tsx',
  'parsing-users': 'src/features/modules/ParticipantsParserModule.tsx',
  'parsing-messages': 'src/features/modules/ParticipantsParserModule.tsx',
  'parsing-comments': 'src/features/modules/ParticipantsParserModule.tsx',
}
const DEFAULT_OWNER = 'src/features/modules/LiveModule.tsx'

/**
 * Мейлинг и автопостинг живут отдельными страницами, а не карточкой модуля, но шаблоны у
 * них те же — и терять настройки они умеют так же. `spam-unblock` запускается фоном из
 * менеджера аккаунтов, формы у него нет: шаблону там неоткуда взяться.
 */
const PAGE_OWNER = {
  mailing: 'src/pages/MailingPage.tsx',
  autoposting: 'src/pages/AutopostingPage.tsx',
}
const NO_FORM = new Set(['spam-unblock'])

/**
 * Ситуативное — в шаблон не идёт осознанно: аккаунты и цели выбирают под конкретный
 * запуск, цель/кампания/агент живут своей жизнью, срок задаётся при постановке задачи.
 */
const SITUATIONAL = new Set(['accountIds', 'channels', 'targets', 'postUrls', 'deadline', 'goalId', 'campaignId', 'agentId'])

/**
 * Контрола в интерфейсе модуля нет — значение приходит от MCP-агента и доезжает до
 * сервера подложкой `usePresetCarry`, а не через `setX`. Список не про долг шаблона, а
 * про то, чего форма осознанно не показывает оператору.
 *
 * `alreadyParsed` считается на запуске из истории модуля (gatherAlreadyParsed), в
 * шаблоне ему делать нечего. `intersectionMin` объявлен дескриптором, но не сделан
 * нигде — ни в форме, ни на сервере; это долг модуля, а не шаблона.
 */
const NO_CONTROL = {
  'neuro-dialogs': ['workMode', 'durationMinutes', 'followUp', 'typeWeights', 'threads'],
  parsing: ['alreadyParsed', 'delayPreset'],
  'parsing-groups': ['alreadyParsed', 'delayPreset'],
  'parsing-users': ['delayPreset', 'intersectionMin'],
  'parsing-messages': ['delayPreset'],
  'parsing-comments': ['delayPreset'],
  // `allowLowTrust` вычисляется на месте (аккаунты ниже порога trust) — в шаблоне ему
  // делать нечего. Промпты и распределение типов у рассылки задаются одним своим текстом,
  // карточек промптов там нет.
  mailing: ['allowLowTrust', 'typeWeights', 'promptIndex', 'promptOverrides'],
  // Уровень защиты автопостинга зафиксирован в коде (protLevel = 1), контрола нет.
  autoposting: ['protectionLevel'],
}

/** Поля есть в контракте, но не сделаны ни в форме, ни на сервере — долг модуля. */
const KNOWN_GAPS = new Set(['semanticFilter', 'semanticThreshold', 'promptText'])

const read = async (p) => fs.readFile(new URL(`../../${p}`, import.meta.url), 'utf8')

/** Тело applyPreset нужного компонента — по нему и смотрим, что восстанавливается. */
async function restoreBody(src, file) {
  const at = src.indexOf('const applyPreset')
  assert.ok(at > 0, `${file}: applyPreset на месте — иначе тест сторожит пустоту`)
  const end = src.indexOf('}, [', at)
  return src.slice(at, end > at ? end : at + 4000)
}

test('шаблон восстанавливает параметры модулей — новые поля мимо него не добавить', async () => {
  const cfg = await read('src/shared/config/modules.ts')
  const live = new Set([...cfg.slice(cfg.indexOf('export const MODULES')).matchAll(/^ {2}'?([a-z-]+)'?:\s*\{/gm)].map((m) => m[1]))
  assert.ok(live.size > 5, 'список модулей прочитан — иначе тест ничего не проверяет')

  const bodies = new Map()
  const missing = []
  for (const d of Object.values(DESCRIPTORS)) {
    if (NO_FORM.has(d.key)) continue
    if (!live.has(d.key) && !PAGE_OWNER[d.key]) continue
    const file = OWNER[d.key] || PAGE_OWNER[d.key] || DEFAULT_OWNER
    if (!bodies.has(file)) bodies.set(file, await restoreBody(await read(file), file))
    const body = bodies.get(file)
    const noControl = new Set(NO_CONTROL[d.key] || [])
    for (const p of d.params || []) {
      const key = p.key || p.name
      if (!key || SITUATIONAL.has(key) || KNOWN_GAPS.has(key) || noControl.has(key)) continue
      if (body.includes(`s.${key}`)) continue
      // Синоним: в storedAs назван другой ключ, и его компонент восстанавливает.
      const alt = [...String(p.storedAs || '').matchAll(/\b([a-z][A-Za-z]+)\b/g)]
        .map((m) => m[1]).find((n) => n !== key && body.includes(`s.${n}`))
      if (!alt) missing.push(`${d.key}.${key}`)
    }
  }
  assert.deepEqual(missing, [], `эти параметры модуль объявил, но шаблон их не восстанавливает: ${missing.join(', ')}`)
})

test('применённый шаблон доезжает до сервера целиком — даже без контрола в форме', async () => {
  const files = [...new Set([...Object.values(OWNER), ...Object.values(PAGE_OWNER), DEFAULT_OWNER])]
  for (const file of files) {
    const src = await read(file)
    assert.match(src, /usePresetCarry/, `${file}: модуль обязан подкладывать применённый шаблон (usePresetCarry)`)
    assert.match(src, /\.\.\.carry\(\)/, `${file}: buildSettings обязан начинаться с ...carry() — иначе поля без контрола теряются на запуске`)
    const body = await restoreBody(src, file)
    assert.match(body, /remember\(s\)/, `${file}: applyPreset обязан запомнить шаблон (remember) — иначе подкладывать нечего`)
  }
})

test('список известных пробелов не разрастается', () => {
  assert.ok(KNOWN_GAPS.size <= 3, `известных пробелов стало больше (${KNOWN_GAPS.size}) — их надо закрывать, а не пополнять`)
})
