/**
 * Аудит констант в коде (созвон 19.08).
 *
 * Дословно: «напиши мне все константы, которые только есть в коде — в каком файле, для
 * чего используется, почему осталась в файле, есть ли в БД и в какой таблице». Просьба
 * возникла после разбора цен: значения, которые обязаны приходить из базы, лежали
 * прописанными в файлах, и цена собиралась непонятно из чего.
 *
 * Скрипт не решает за человека — он показывает список и раскладывает его на две кучи:
 *   • бизнес-значения (цены, лимиты, сроки, проценты) — им место в БД, каждое надо
 *     объяснить или вынести;
 *   • техника (ключи, таймауты сети, размеры буферов, регулярки) — в коде это норма.
 *
 *   node scripts/audit-constants.mjs            # сводка в консоль
 *   node scripts/audit-constants.mjs --md       # готовый документ в docs/
 */
import fs from 'node:fs/promises'
import path from 'node:path'

const ROOTS = ['server', 'src']
const SKIP = /node_modules|__tests__|\.test\.|dist|build/

/**
 * Деньги. Такое значение решает, сколько человек платит, — ему место только в базе,
 * а в коде допустим лишь запасной вариант для дев-режима и тестов.
 */
const MONEY = /(PRICE|COST|USD|COIN|DISCOUNT|TARIFF|PLAN|BONUS|GIFT|FEE|TOKEN_USD|PER_1M|SHARE)/
/**
 * Правила работы: пороги, лимиты, сроки. Не деньги, но их владелец рано или поздно
 * захочет крутить сам — значит про каждое надо решить осознанно, а не забыть в файле.
 */
const RULES = /(TRUST|QUOTA|LIMIT|MAX_|MIN_|_MAX|_MIN|THRESHOLD|TARGET|PARALLEL|BURST|DEPTH|FOLLOW_UP|DEADLINE|MONTH)/
/** Техника: сеть, размеры, ключи, пути. В коде им и место. */
const TECHNICAL = /(TIMEOUT|RETRY|INTERVAL|TTL|BUFFER|CHUNK|BYTES|REGEX|RE_|HEADER|_KEY|KEY$|URL|PATH|FILE|DIR|ENCODING|MIME|PORT|VERSION|SCHEMA|TABLE|^DAY|_MS$|MS$)/

async function walk(dir, out = []) {
  let items = []
  try { items = await fs.readdir(dir, { withFileTypes: true }) } catch { return out }
  for (const it of items) {
    const p = path.join(dir, it.name)
    if (SKIP.test(p)) continue
    if (it.isDirectory()) await walk(p, out)
    else if (/\.(js|mjs|ts|tsx)$/.test(it.name)) out.push(p)
  }
  return out
}

const files = (await Promise.all(ROOTS.map((r) => walk(r)))).flat()
const found = []
for (const f of files) {
  const src = await fs.readFile(f, 'utf8')
  const lines = src.split('\n')
  lines.forEach((line, i) => {
    // Только объявления модульного уровня: const ИМЯ_БОЛЬШИМИ = значение
    const m = /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*(?::[^=]+)?=\s*(.+?)\s*$/.exec(line)
    if (!m) return
    const [, name, rawValue] = m
    // Интересуют значения, а не импорты/функции: число, строка, простой объект/массив.
    if (/^(async\s+)?\(|=>|require\(|await\s/.test(rawValue)) return
    // Пояснение рядом: ближайшая строка комментария выше. `*/` и пустые рамки JSDoc
    // пропускаем — иначе в таблицу попадает мусор вместо смысла.
    let prev = ''
    for (let k = i - 1; k >= 0 && k > i - 6; k -= 1) {
      const t = (lines[k] || '').trim()
      if (!t || t === '*/' || t === '/**' || t === '*') continue
      if (/^(\/\/|\*)/.test(t)) { prev = t; break }
      break
    }
    found.push({
      file: f.split(path.sep).join('/'),
      line: i + 1,
      name,
      value: rawValue.replace(/\s+/g, ' ').slice(0, 70),
      note: prev ? prev.replace(/^(\/\/|\*)\s?/, '').slice(0, 100) : '',
      kind: TECHNICAL.test(name) ? 'technical'
        : MONEY.test(name) ? 'money'
          : RULES.test(name) ? 'rules' : 'technical',
    })
  })
}

const by = (k) => found.filter((x) => x.kind === k).sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))
const money = by('money'), rules = by('rules'), tech = by('technical')
const biz = [...money, ...rules]

if (!process.argv.includes('--md')) {
  console.log(`Констант найдено: ${found.length} (бизнес-значений ${biz.length}, техники ${tech.length})\n`)
  console.log('БИЗНЕС-ЗНАЧЕНИЯ — им место в базе:')
  for (const c of biz) console.log(`  ${c.name.padEnd(26)} ${c.value.padEnd(30)} ${c.file}:${c.line}`)
  process.exit(0)
}

const table = (list) => list.map((c) => `| \`${c.name}\` | \`${c.value}\` | [${c.file}:${c.line}](../${c.file}#L${c.line}) | ${c.note || '—'} |`).join(String.fromCharCode(10))
const md = `# Аудит констант в коде

Собран скриптом \`scripts/audit-constants.mjs\`. Повторить: \`node scripts/audit-constants.mjs --md\`.

Просьба с созвона 19.08: показать все константы — где лежат, зачем нужны, есть ли в базе.
Повод: цены собирались из значений, вписанных в файлы, и понять, откуда берётся сумма,
было нельзя.

Найдено **${found.length}** констант: **${biz.length}** похожи на бизнес-значения
(деньги, лимиты, сроки, проценты), **${tech.length}** — техника (таймауты, ключи, пути,
размеры), и ей в коде самое место.

## Бизнес-значения — проверить каждое

Правило простое: если значение решает, сколько человек платит или сколько ему можно, —
оно живёт в базе, а в коде остаётся только запасной вариант для дев-режима и тестов.

### Деньги (${money.length}) — только из базы

| Константа | Значение | Где | Что рядом написано в коде |
|---|---|---|---|
${table(money)}

### Правила работы (${rules.length}) — решить по каждому

Не деньги, но владелец рано или поздно захочет крутить их сам: пороги доверия, лимиты
безопасности, сроки. Пока в коде — значит меняются только выкатом.

| Константа | Значение | Где | Что рядом написано в коде |
|---|---|---|---|
${table(rules)}

## Разбор денежных констант

Проверено вручную, чтобы список не читался как «всё плохо»:

- \`MODULE_MONTH_PRICE\`, \`ACTION_PRICE\`, \`COIN_PACKS\`, \`ANNUAL_DISCOUNT\`,
  \`MODEL_PRICES_PER_1M\` — запасные значения для дев-режима и тестов. В рабочем режиме
  не читаются: цены приходят из \`module_prices\`, \`price_overrides\`, \`setups\`,
  \`model_prices\`. Проверяется прогоном: ни один модуль не остаётся без цены из базы.
- \`INPUT_SHARE = 0.75\` — бывшая догадка «75/25». Сейчас доля входящих токенов считается
  по факту из журнала расхода, константа осталась запасным вариантом.
- \`COINS_PER_1K_TOKENS = 1\` — остаток формулы, которую убрали (созвон 19.08: «этого
  значения не должно существовать»). В списании не участвует, ни в одном экране не
  показывается. Мёртвый вес: считается \`tokenCoins\`, который нигде не выводится.
  Убрать вместе с колонкой \`coins\` в журнале расхода ИИ — отдельной правкой.
- \`ANNUAL_DISCOUNT\` на лендинге — запасной вариант, если периоды не пришли из админки.
  Живой скидкой не является, но лучше показывать один месяц, чем придуманные 20%.
- \`PLANS\`, \`COIN_PRECISION\`, \`HEALTHY_COINS\`, \`BONUS_MODULE\` — не цены:
  тариф-заглушка, точность округления монет, порог «мало токенов» в шапке и ключ
  бонусного модуля на лендинге.

## Техника — оставляем в коде

${tech.length} штук: таймауты сети, размеры буферов, ключи хранилищ, пути к файлам,
регулярные выражения, версии схем. Выносить их в базу незачем — они не про деньги и не
про правила, а про то, как работает сам код.
`
await fs.mkdir('docs', { recursive: true })
await fs.writeFile('docs/CONSTANTS-AUDIT.md', md, 'utf8')
console.log(`docs/CONSTANTS-AUDIT.md собран: ${found.length} констант, из них ${biz.length} бизнес-значений`)
