import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DESCRIPTORS, listDescriptorKeys, describeModule, buildInputSchema, descriptorTopLevelNames,
  descriptorFieldNames,
} from '../mcp/descriptors/index.js'
import { extractFunctionBody, scanSettingsKeys, scanDescriptorSources } from '../mcp/contractScan.js'
import { delayMultiplier, effectiveProbability } from '../lib/protection.js'
import { resolveDurationPeriodMinutes } from '../lib/workModeDuration.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ────────────────────────────────────────────────────────────────────────────────
// ГЛАВНЫЙ ТЕСТ РАЗДЕЛА. Всё остальное здесь — вспомогательное.
//
// Заказчик встал именно на этом: «ни хрена не соотносятся то, что написано в джейсоне,
// с тем, какие параметры реально есть у каждого модуля» (созвон 14.08). Манифест обещал
// «мозгам» 5 полей при реальных 32 — и оркестратор по нему собирал нерабочие задачи.
// Дисциплина «не забудь обновить схему» уже отказала один раз, поэтому проверка машинная.
// ────────────────────────────────────────────────────────────────────────────────
test('contract: каждое поле, которое читает воркер, описано в дескрипторе', async () => {
  for (const key of listDescriptorKeys()) {
    const desc = DESCRIPTORS[key]
    const { keys, missingSymbols } = await scanDescriptorSources(desc, ROOT)

    // Если функцию переименовали, сканер увидит пустоту и «докажет», что всё в порядке.
    assert.deepEqual(missingSymbols, [], `${key}: contract.sources указывает на несуществующие функции`)
    assert.ok(keys.size > 0, `${key}: сканер не нашёл ни одного обращения к настройкам — источники заданы неверно`)

    const known = descriptorTopLevelNames(desc)
    const ignored = new Set(desc.contract?.ignore || [])
    const undocumented = [...keys].filter((k) => !known.has(k) && !ignored.has(k))

    assert.deepEqual(
      undocumented, [],
      `${key}: код читает поля, которых нет в дескрипторе — ${undocumented.join(', ')}.\n`
      + 'Добавьте их в params (docs/mcp/MCP-CONTRIBUTING.md) — иначе «мозги» о них не узнают.',
    )
  }
})

test('contract: в дескрипторе нет мёртвых полей — каждое реально читается кодом', async () => {
  for (const key of listDescriptorKeys()) {
    const desc = DESCRIPTORS[key]
    const { keys } = await scanDescriptorSources(desc, ROOT)

    const dead = (desc.params || [])
      // Поле считается живым, если читается само или под любым из своих алиасов.
      .filter((p) => !keys.has(p.name) && !(p.aliases || []).some((a) => keys.has(a)))
      .map((p) => p.name)

    assert.deepEqual(
      dead, [],
      `${key}: в схеме есть поля, которые код не читает — ${dead.join(', ')}. `
      + 'Либо реализуйте, либо уберите: «мозги» будут их заполнять впустую.',
    )
  }
})

test('целостность: блоки и параметры ссылаются друг на друга без дыр', () => {
  for (const key of listDescriptorKeys()) {
    const desc = DESCRIPTORS[key]
    const blockIds = new Set(desc.blocks.map((b) => b.id))
    const paramNames = new Set(desc.params.map((p) => p.name))

    for (const p of desc.params) {
      assert.ok(blockIds.has(p.block), `${key}.${p.name}: блок «${p.block}» не объявлен`)
      assert.ok(p.title, `${key}.${p.name}: нет title`)
      assert.ok(p.purpose, `${key}.${p.name}: нет purpose — «мозги» не поймут, зачем поле`)
      for (const ref of p.seeAlso || []) {
        assert.ok(paramNames.has(ref), `${key}.${p.name}: seeAlso ссылается на несуществующее поле «${ref}»`)
      }
    }

    // Обратная сторона: блок не должен обещать параметр, которого нет.
    for (const b of desc.blocks) {
      assert.ok(b.purpose && b.howItWorks, `${key}.${b.id}: блок без описания работы`)
      assert.ok(b.api?.path, `${key}.${b.id}: не указан API — заказчик просил именно это`)
      for (const name of b.params) {
        assert.ok(paramNames.has(name), `${key}.${b.id}: ссылается на несуществующий параметр «${name}»`)
      }
    }

    // Каждый параметр должен быть виден хотя бы в одном блоке, иначе он выпадает из help.
    const inBlocks = new Set(desc.blocks.flatMap((b) => b.params))
    for (const name of paramNames) {
      assert.ok(inBlocks.has(name), `${key}.${name}: параметр не попал ни в один блок`)
    }
  }
})

test('значения: enum расшифрованы, границы не противоречат умолчанию', () => {
  for (const key of listDescriptorKeys()) {
    for (const p of DESCRIPTORS[key].params) {
      if (p.enum) {
        const values = p.enum.map((e) => e.value)
        assert.equal(new Set(values).size, values.length, `${key}.${p.name}: повторяющиеся значения enum`)
        for (const e of p.enum) {
          // Заказчик просил не подпись, а смысл: «min обозначает, что аккаунт будет
          // проверяться каждые 2 минуты…» — иначе значение ничего не сообщает.
          assert.ok(e.label, `${key}.${p.name}=${e.value}: нет подписи`)
          assert.ok(e.means, `${key}.${p.name}=${e.value}: не расшифровано, что значение делает`)
        }
        if (p.default !== undefined) {
          assert.ok(values.includes(p.default), `${key}.${p.name}: умолчание вне списка значений`)
        }
      }
      if (p.min !== undefined && p.max !== undefined) {
        assert.ok(p.min <= p.max, `${key}.${p.name}: min больше max`)
      }
      if (typeof p.default === 'number') {
        if (p.min !== undefined) assert.ok(p.default >= p.min, `${key}.${p.name}: умолчание ниже min`)
        if (p.max !== undefined) assert.ok(p.default <= p.max, `${key}.${p.name}: умолчание выше max`)
      }
    }
  }
})

test('usesAi объявлен явно у каждого модуля и доезжает до клиента', () => {
  // Поле не косметическое: по нему `priceStore.js` решает, начислять ли модулю месячный
  // пакет токенов, а «мозги» — добавлять ли расход на генерацию к цене действия.
  //
  // Ловим ровно два дефекта, которые уже случились. Первый: у пяти парсеров значение было
  // `undefined` — обёртки его передавали, фабрика не читала. `undefined` здесь опаснее
  // `false`: «не знаю» неотличимо от «нет». Второй: поле было в дескрипторе, но ни
  // `describeModule`, ни `summarizeModule` его не отдавали, то есть наружу оно не выходило
  // вовсе — тот самый рассинхрон схемы и реальности, ради которого заведён весь раздел.
  for (const key of listDescriptorKeys()) {
    const raw = DESCRIPTORS[key].usesAi
    assert.equal(typeof raw, 'boolean', `${key}: usesAi обязан быть объявлен явно (сейчас ${raw})`)
    assert.equal(describeModule(key).usesAi, raw, `${key}: describeModule не отдаёт usesAi`)
  }

  // Сверяем с реальностью, а не с самим собой: генерацию делает тот, кто зовёт
  // resolveSystemPrompt из общего генератора. Список ИИ-модулей мал и меняется редко —
  // если он изменится, тест обязан это заметить.
  const ai = listDescriptorKeys().filter((k) => DESCRIPTORS[k].usesAi)
  assert.deepEqual(ai.sort(), ['mailing', 'neuro-chatting', 'neuro-commenting', 'neuro-dialogs'])
})

test('whoAmI заполнен полностью — модуль сам объясняет, что он делает и чего не делает', () => {
  for (const key of listDescriptorKeys()) {
    const w = DESCRIPTORS[key].whoAmI
    assert.ok(w?.summary, `${key}: нет summary`)
    assert.ok(w.does?.length, `${key}: не описано, что модуль делает`)
    // Без doesNot оркестратор регулярно выбирает не тот модуль — «напиши в личку»
    // уходит в нейрокомментинг, потому что тот тоже «пишет текст».
    assert.ok(w.doesNot?.length, `${key}: не описано, чего модуль НЕ делает`)
    assert.ok(w.requires?.length, `${key}: не описаны предусловия`)
    assert.ok(w.risks, `${key}: не описаны риски`)
    assert.ok(w.costModel, `${key}: не описана модель списания`)
  }
})

test('пресеты: числа в схеме совпадают с поведением сервера', () => {
  const desc = DESCRIPTORS['neuro-commenting']
  const base = delayMultiplier(1, 1) // сбалансированный × сбалансированный

  const tempo = desc.presets.find((p) => p.param === 'delayPreset')
  for (const v of tempo.values) {
    if (v.value === 3) continue // Custom: сервер трактует как ×1 через `?? 1`
    // Сравниваем ОТНОШЕНИЕ, а не абсолют: глобальный множитель ИИ-безопасности
    // общий для обоих вызовов и в отношении сокращается.
    const ratio = delayMultiplier(1, v.value) / base
    assert.ok(Math.abs(ratio - v.multiplier) < 1e-9, `delayPreset=${v.value}: схема обещает ×${v.multiplier}, сервер даёт ×${ratio}`)
  }

  const level = desc.presets.find((p) => p.param === 'protectionLevel')
  for (const v of level.values) {
    const ratio = delayMultiplier(v.value, 1) / base
    assert.ok(Math.abs(ratio - v.multiplier) < 1e-9, `protectionLevel=${v.value}: схема обещает ×${v.multiplier}, сервер даёт ×${ratio}`)

    // Потолок вероятности: подаём заведомо максимум и смотрим, до чего его срежут.
    assert.equal(effectiveProbability(100, true, v.value), v.probabilityCap,
      `protectionLevel=${v.value}: потолок вероятности в схеме не совпадает с сервером`)

    // Нижняя граница длительности при работе по времени.
    const period = resolveDurationPeriodMinutes({ durationMinutes: 100000, protectionLevel: v.value }, { taskId: 't1' })
    assert.equal(period.min, v.minDurationMinutes,
      `protectionLevel=${v.value}: минимальная длительность в схеме не совпадает с сервером`)
  }
})

test('inputSchema: валидная JSON Schema с ограничениями, а не голый список полей', () => {
  const schema = buildInputSchema(DESCRIPTORS['neuro-commenting'])

  assert.equal(schema.type, 'object')
  assert.equal(schema.additionalProperties, false, 'незнакомое поле должно отвергаться, а не проглатываться')
  assert.deepEqual(schema.required.sort(), ['accountIds', 'channels'])

  // Ограничения обязаны доехать до «мозгов» машинно — ради этого всё и затевалось.
  assert.equal(schema.properties.probability.minimum, 0)
  assert.equal(schema.properties.probability.maximum, 100)
  assert.equal(schema.properties.postWindow.maximum, 50)
  assert.deepEqual(schema.properties.commentMode.enum, [0, 1, 2])
  assert.equal(schema.properties.accountIds.type, 'array')
  assert.equal(schema.properties.accountIds.items.type, 'string')

  // Вложенный объект задержек описан, а не свален в «object».
  assert.equal(schema.properties.delays.properties.floodQuarantine.minimum, 1)
  assert.deepEqual(schema.properties.delays.properties.comment.default, [30, 120])

  // The enum meaning must be exposed in the description text shown by the MCP client.
  assert.match(schema.properties.commentMode.description, /By keywords/i)
  assert.match(schema.properties.probability.description, /Constraints: /)
  // Диалект объявляем явно: молчаливое умолчание — лишний повод для расхождения
  // с валидатором на той стороне.
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema')
})

// ────────────────────────────────────────────────────────────────────────────────
// КАЧЕСТВО ТЕКСТА. Дескриптор читает не человек, а модель, и текст здесь — не
// оформление, а данные. После машинного перевода файлов раздела в схеме осело 94 склейки
// без пробела («FloodWait →account quarantine», «in progress' + 'task.»), шесть пропусков
// пробела после точки и дублирующиеся теги в 13 дескрипторах из 15: пары синонимов
// «комментарии/comments» перевелись в одно слово дважды. Проверяем машинно — глазами
// такое не ловится, а модель по такому тексту делает выводы.
// ────────────────────────────────────────────────────────────────────────────────

/** Собрать ВСЕ строки дескриптора, включая вложенные. */
function allStrings(node, out = []) {
  if (typeof node === 'string') out.push(node)
  else if (Array.isArray(node)) for (const v of node) allStrings(v, out)
  else if (node && typeof node === 'object') for (const v of Object.values(node)) allStrings(v, out)
  return out
}

test('тексты: нет склеек без пробела — их оставил машинный перевод', () => {
  // Буква, затем точка/запятая, затем сразу заглавная: «reads a lot.Pauses».
  const GLUED = /[a-zа-яё0-9][.,;][A-ZА-ЯЁ][a-zа-яё]/
  // Строчная буква вплотную к заглавной: «progresstask» так не поймать, а вот
  // «actionAnalysis» — да; camelCase-имена полей исключаем по словарю ниже.
  for (const key of listDescriptorKeys()) {
    for (const s of allStrings(DESCRIPTORS[key])) {
      const m = GLUED.exec(s)
      assert.equal(m, null, `${key}: пропущен пробел после «${m?.[0]}» в строке: ${s.slice(0, 120)}`)
    }
  }
})

test('теги: уникальны, непусты и в нижнем регистре — по ним ищут модуль', () => {
  for (const key of listDescriptorKeys()) {
    const tags = DESCRIPTORS[key].tags || []
    assert.ok(tags.length >= 3, `${key}: слишком мало ключевых слов для поиска`)
    assert.equal(new Set(tags).size, tags.length, `${key}: повторяющиеся теги — ${tags.join(', ')}`)
    for (const t of tags) {
      assert.ok(t.trim(), `${key}: пустой тег`)
      assert.equal(t, t.toLowerCase(), `${key}: тег «${t}» не в нижнем регистре — поиск по нему промахнётся`)
    }
  }
})

test('MCP-MAP: таблица покрытия совпадает с дескрипторами', async () => {
  // Документ тоже умеет врать, и врал: в таблице у мейлинга стояло «19 полей, 8 блоков»
  // при реальных пяти параметрах и семи блоках. Цифры вели руками, они разошлись, и
  // читающий документ узнавал не то, что отдаёт сервер, — та же болезнь этажом выше.
  const { readFile } = await import('node:fs/promises')
  const md = await readFile(path.join(ROOT, 'docs/mcp/MCP-MAP.md'), 'utf8')

  const rows = [...md.matchAll(/^\| \d+ \| `([\w-]+)` \|[^|]+\|[^|]+\| \*\*(\d+)\*\* \| (\d+) \| (\d+) \| v(\d+) \|$/gm)]
  assert.equal(rows.length, listDescriptorKeys().length, 'в таблице должен быть каждый модуль и ни одного лишнего')

  for (const [, key, params, fields, blocks, version] of rows) {
    const desc = DESCRIPTORS[key]
    assert.ok(desc, `MCP-MAP перечисляет модуль «${key}», которого нет в реестре дескрипторов`)
    assert.equal(Number(params), desc.params.length, `MCP-MAP: у «${key}» неверное число параметров`)
    assert.equal(Number(fields), descriptorFieldNames(desc).size, `MCP-MAP: у «${key}» неверное число полей`)
    assert.equal(Number(blocks), desc.blocks.length, `MCP-MAP: у «${key}» неверное число блоков`)
    assert.equal(Number(version), desc.version, `MCP-MAP: у «${key}» неверная версия схемы`)
  }
})

test('ЯЗЫК MCP — только английский: ни одной кириллицы в том, что уезжает клиенту', async () => {
  // Правило раздела (CLAUDE.md → «ЯЗЫК MCP»). Проверяем ВЕСЬ клиентский срез, а не одни
  // params: русский уже приезжал из whoAmI, из блоков, из enum.label, из unit и из
  // проверки запуска — каждый раз мимо теста, который смотрел только на params.
  //
  // Смешанный язык в одном ответе не косметика: модель, читающая описание поля на другом
  // языке, чем остальная схема, начинает отвечать на нём же, а оркестратор у заказчика
  // англоязычный. Комментарии в коде и docs/mcp/*.md — по-русски, их читают люди.
  const CYRILLIC = /[а-яё]/i
  // Единственное исключение: дословные цитаты строк продукта, которые модель должна
  // узнать в тексте цели байт в байт.
  const ALLOWED = /Первое сообщение/
  const found = []
  const walk = (node, path) => {
    if (typeof node === 'string') {
      if (CYRILLIC.test(node) && !ALLOWED.test(node)) found.push(`${path}: «${node.slice(0, 90)}»`)
    } else if (Array.isArray(node)) node.forEach((v, i) => walk(v, `${path}[${i}]`))
    else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
  }

  // 1. Дескрипторы целиком — ровно то, что отдаёт describe_module.
  for (const key of listDescriptorKeys()) walk(describeModule(key), key)

  // 2. Инструменты, промпты и инструкция сервера.
  const { TOOLS } = await import('../mcp/tools.js')
  const { PROMPTS, getPrompt } = await import('../mcp/prompts.js')
  const { INSTRUCTIONS, RESOURCE_TEMPLATES } = await import('../mcp/server.js')
  walk(TOOLS, 'TOOLS')
  walk(PROMPTS, 'PROMPTS')
  walk(RESOURCE_TEMPLATES, 'RESOURCE_TEMPLATES')
  walk(INSTRUCTIONS, 'INSTRUCTIONS')
  for (const p of PROMPTS) walk(getPrompt(p.name, {}), `prompt:${p.name}`)

  // 3. Тексты валидатора: и схемные, и правила запуска. Последние приходят из
  //    `validateSettingsDetailed`, который обслуживает ещё и русскую панель, — сюда
  //    обязан уезжать `messageEn`.
  const { callTool } = await import('../mcp/tools.js')
  walk(await callTool('validate_task', {
    module: 'neuro-commenting',
    // Имя поля намеренно латиницей: валидатор цитирует ввод дословно, и кириллица
    // в НАШЕЙ фикстуре вернулась бы эхом и выглядела как нарушение правила.
    settings: { accountIds: [], probability: 500, unknownFieldHere: 1 },
  }, {}), 'validate_task:schema')
  walk(await callTool('validate_task', {
    module: 'neuro-commenting',
    settings: { accountIds: ['a'], channels: ['@x'], minComments: 50, maxComments: 10 },
  }, {}), 'validate_task:launchRule')

  assert.deepEqual(found, [], `Кириллица в клиентском срезе MCP:
  ${found.join('\n  ')}`)
})

test('единицы измерения записаны машинно-однозначно', () => {
  // `unit: 'With'` — это русское «с» (секунды), пропущенное через машинный перевод.
  // Таких было 22 штуки: модель читала «единица измерения — With».
  const OK = new Set(['s', 'min', 'h', '%'])
  for (const key of listDescriptorKeys()) {
    const units = []
    const walk = (n) => {
      if (Array.isArray(n)) n.forEach(walk)
      else if (n && typeof n === 'object') {
        if (typeof n.unit === 'string') units.push(n.unit)
        Object.values(n).forEach(walk)
      }
    }
    walk(DESCRIPTORS[key].params || [])
    for (const u of units) assert.ok(OK.has(u), `${key}: непонятная единица «${u}». Допустимы: ${[...OK].join(', ')}`)
  }
})

test('describeModule отдаёт всё, что просил заказчик, одним ответом', () => {
  const d = describeModule('neuro-commenting')

  assert.ok(d.whoAmI.summary, 'кто я — по модулю, а не глобально')
  assert.ok(d.blocks.length >= 8, 'блоки интерфейса')
  assert.ok(d.params.length >= 25, 'все параметры, а не 5 как в старом манифесте')
  assert.ok(d.presets.length >= 2, 'расшифровка пресетов')
  assert.ok(d.examples.length >= 2, 'сценарии использования')
  assert.ok(d.inputSchema.properties.accountIds, 'машинная схема входа')
  assert.ok(d.tags.length, 'ключевые слова для поиска')

  // В блоке параметры уже развёрнуты — «мозгам» не надо джойнить руками.
  const accounts = d.blocks.find((b) => b.id === 'accounts')
  assert.equal(accounts.params[0].name, 'accountIds')
  assert.ok(accounts.params[0].purpose)
  assert.ok(accounts.api.fills.includes('accountIds'), 'какие поля API заполняет этот блок')
  assert.equal(d.blocks.some((b) => b.params.some((p) => p.missing)), false, 'битых ссылок на параметры нет')

  assert.equal(describeModule('нет-такого'), null)
})

// ── сканер: проверяем инструмент, которым проверяем всё остальное ────────────────

test('scanSettingsKeys видит обращения к настройкам и не хватает чужие объекты', () => {
  const code = `
    const s = task.settings
    const a = s.accountIds || []
    const w = s.delays?.comment?.[0] ?? 30
    if (settings.commentMode === 1) return posts.filter((p) => p.id > 0)
    const t = settings?.semanticThreshold
    const g = task.settings.goalId
    meta.status = 'x'; results.map((r) => r.value)
  `
  const keys = scanSettingsKeys(code)
  assert.deepEqual([...keys].sort(), ['accountIds', 'commentMode', 'delays', 'goalId', 'semanticThreshold'])
})

test('extractFunctionBody берёт тело целиком и не путается во вложенных скобках', () => {
  const src = 'export async function foo(a) {\n  if (a) { return { x: 1 } }\n  return 0\n}\nfunction bar() { return 9 }'
  const body = extractFunctionBody(src, 'foo')
  assert.match(body, /return \{ x: 1 \}/)
  assert.match(body, /return 0/)
  assert.equal(/return 9/.test(body), false, 'тело соседней функции не должно попадать в выборку')
  assert.equal(extractFunctionBody(src, 'нетТакой'), '')
})
