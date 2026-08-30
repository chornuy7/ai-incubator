/**
 * Contract-тест: docs/WORKFLOW-rules.html не расходится с правилами.
 *
 * Зачем он есть. HTML — пересказ регламента для человека, и раньше он поддерживался руками.
 * За один день он отстал шесть раз: формат ветки был двух поколений давности, три правила
 * остались отменёнными, двух шаблонов не было вовсе. Причём дважды расхождение возникало сразу
 * после доклада «всё синхронизировано» — то есть на внимательность полагаться нельзя.
 *
 * Теперь изменчивые куски генерируются (scripts/gen-workflow-html.mjs), а этот тест не даёт
 * им разойтись снова: он проверяет и генератор, и результат независимо от него.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

import { parseTemplates } from '../../scripts/gen-workflow-html.mjs'

const html = readFileSync('docs/WORKFLOW-rules.html', 'utf8')
const claudeMd = readFileSync('CLAUDE.md', 'utf8')
const skillMd = readFileSync('.claude/skills/task-workflow/SKILL.md', 'utf8')

const templates = [
  ...parseTemplates(claudeMd.split('### Два шаблона')[1] ?? ''),
  ...parseTemplates(skillMd.split('## Шаблоны остановки')[1] ?? ''),
]

// Как текст выглядит в HTML: спецсимволы экранированы, `код` завёрнут в span.
const asHtml = (s) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/`([^`]+)`/g, '<span class="m">$1</span>')

test('шаблоны остановки вообще разбираются из источников', () => {
  assert.ok(
    templates.length >= 8,
    `разобрано ${templates.length} шаблонов — источники читаются неверно, а не правила изменились`,
  )
})

test('каждый шаблон присутствует в HTML дословно', () => {
  // Регламент требует воспроизводить шаблоны слово в слово. Значит и пересказ для человека
  // обязан показывать ровно тот же текст — иначе люди учат одну формулировку, а слышат другую.
  const missing = []
  for (const t of templates) {
    for (const shout of t.shouts) {
      if (!html.includes(asHtml(shout))) missing.push(`${t.when} → ${shout}`)
    }
  }
  assert.deepEqual(missing, [], `в HTML нет этих строк:\n  ${missing.join('\n  ')}`)
})

test('формат имени ветки в HTML совпадает с CLAUDE.md', () => {
  const branch = claudeMd.match(/\*\*`(feat\/[^`]+)`\*\*/)?.[1]
  assert.ok(branch, 'в CLAUDE.md не найден формат имени ветки')
  assert.ok(
    html.includes(asHtml(branch)),
    `HTML не содержит актуальный формат ветки ${branch}`,
  )
})

test('генератор не находит расхождений (npm run gen:workflow не нужен)', () => {
  // Если этот тест красный — правила изменились, а HTML нет. Чинится одной командой,
  // сообщение об этом печатает сам генератор.
  execFileSync('node', ['scripts/gen-workflow-html.mjs', '--check'], { stdio: 'pipe' })
})
