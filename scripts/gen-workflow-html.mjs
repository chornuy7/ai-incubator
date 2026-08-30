#!/usr/bin/env node
/**
 * Генерация изменчивых кусков docs/WORKFLOW-rules.html из источников правды.
 *
 * Зачем: HTML — пересказ регламента для человека, и он писался руками. За один день он отстал
 * шесть раз, причём дважды сразу после доклада «всё синхронизировано»: формат ветки был двух
 * поколений давности, три правила остались отменёнными, двух шаблонов не было вовсе. Ручная
 * синхронизация двух текстов не работает — её надо не улучшать, а убирать.
 *
 * Что генерируется, а что нет. Оформление, объяснения и вёрстка остаются рукописными: они и не
 * протухают. Генерируются ровно те куски, которые ОБЯЗАНЫ совпадать дословно с правилами:
 *   • шаблоны остановки — регламент прямо требует воспроизводить их слово в слово;
 *   • формат имени ветки — короткий факт, который менялся дважды за день.
 *
 * Куски размечены парой комментариев в HTML:
 *   <!-- GEN:notes --> … <!-- /GEN:notes -->
 * Всё между ними принадлежит скрипту; править руками бесполезно — перезапишется.
 *
 * Режимы:
 *   node scripts/gen-workflow-html.mjs           переписать HTML
 *   node scripts/gen-workflow-html.mjs --check   не писать, упасть при расхождении (для тестов)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HTML = join(ROOT, 'docs', 'WORKFLOW-rules.html')
const CLAUDE = join(ROOT, 'CLAUDE.md')
const SKILL = join(ROOT, '.claude', 'skills', 'task-workflow', 'SKILL.md')

// ── разбор шаблонов из markdown ─────────────────────────────────────────────
// Шаблон в источнике выглядит так: строка-повод, заканчивающаяся двоеточием, пустая строка,
// дальше цитата. Строки цитаты, обёрнутые в **…**, — это «крик» (ключевая строка заглавными),
// остальные — пояснение под ним, склеиваемое в один абзац.
export function parseTemplates(md) {
  const lines = md.split(/\r?\n/)
  const out = []

  for (let i = 0; i < lines.length; i++) {
    const when = lines[i].trim()
    // повод: обычная строка с двоеточием на конце, не заголовок и не часть цитаты/списка
    if (!when.endsWith(':') || /^[#>\-*|]/.test(when) || when.length > 120) continue

    let j = i + 1
    while (j < lines.length && lines[j].trim() === '') j++
    if (j >= lines.length || !lines[j].startsWith('> ')) continue

    const quote = []
    while (j < lines.length && lines[j].startsWith('>')) {
      quote.push(lines[j].replace(/^>\s?/, ''))
      j++
    }
    if (!quote.length) continue

    const shouts = []
    let after = []
    for (const line of quote) {
      const bold = line.match(/^\*\*(.+)\*\*$/)
      if (bold) {
        shouts.push(bold[1])
      } else if (line.trim()) {
        after.push(line.trim())
      }
    }
    if (!shouts.length) continue

    out.push({
      when: when.slice(0, -1),
      shouts,
      after: after.join(' '),
    })
    i = j - 1
  }
  return out
}

// ── markdown → html для строки шаблона ──────────────────────────────────────
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const inline = (s) => esc(s).replace(/`([^`]+)`/g, '<span class="m">$1</span>')

// Класс врезки выводится из самого текста, а не задаётся отдельно: ⛔ — отказ, ⚠️ с вопросом —
// запрос решения, остальное — простое предупреждение о том, что Claude уже делает.
function noteClass(t) {
  const head = t.shouts[0]
  if (head.startsWith('⛔')) return 'note deny'
  if (head.includes('?')) return 'note ask'
  return 'note'
}

function renderNote(t) {
  const cls = noteClass(t)
  const muted = cls === 'note' ? ' style="color:var(--muted)"' : ''
  const parts = [
    `      <div class="${cls}">`,
    `        <div class="note-when">${inline(t.when)}</div>`,
    ...t.shouts.map((s) => `        <p class="shout"${muted}>${inline(s)}</p>`),
  ]
  if (t.after) parts.push(`        <p class="after">${inline(t.after)}</p>`)
  parts.push('      </div>')
  return parts.join('\n')
}

// ── подстановка между маркерами ─────────────────────────────────────────────
function replaceBlock(html, name, body) {
  const re = new RegExp(`(<!-- GEN:${name} -->)[\\s\\S]*?(<!-- /GEN:${name} -->)`)
  if (!re.test(html)) throw new Error(`в HTML нет маркеров GEN:${name}`)
  return html.replace(re, `$1\n${body}\n$2`)
}

// ── сборка ──────────────────────────────────────────────────────────────────
// Всё ниже выполняется, только когда файл запущен напрямую: contract-тест импортирует отсюда
// parseTemplates, и без этой проверки импорт переписывал бы HTML и убивал процесс через
// process.exit — тест падал бы по причине, не имеющей отношения к правилам.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()

function main() {
const claudeMd = readFileSync(CLAUDE, 'utf8')
const skillMd = readFileSync(SKILL, 'utf8')

// Порядок как в правилах: сначала два гейтовых шаблона из CLAUDE.md, потом процедурные из скилла.
const templates = [
  ...parseTemplates(claudeMd.split('### Два шаблона')[1] ?? ''),
  ...parseTemplates(skillMd.split('## Шаблоны остановки')[1] ?? ''),
]
if (templates.length < 6) {
  console.error(`  ✗ найдено всего ${templates.length} шаблонов — источники разобрались неверно`)
  process.exit(1)
}

const branch = claudeMd.match(/\*\*`(feat\/[^`]+)`\*\*/)?.[1]
if (!branch) {
  console.error('  ✗ в CLAUDE.md не найден формат имени ветки')
  process.exit(1)
}

const before = readFileSync(HTML, 'utf8')
let html = before
html = replaceBlock(html, 'notes', templates.map(renderNote).join('\n\n'))
html = replaceBlock(html, 'branch', `          <span class="m">${esc(branch)}</span>`)

const check = process.argv.includes('--check')
if (html === before) {
  console.log(`  ✓ HTML совпадает с правилами (${templates.length} шаблонов, ветка ${branch})`)
  process.exit(0)
}
if (check) {
  console.error('  ✗ docs/WORKFLOW-rules.html разошёлся с правилами.')
  console.error('    Правила — источник, HTML — производное. Выполни:  npm run gen:workflow')
  process.exit(1)
}
writeFileSync(HTML, html)
console.log(`  ✓ HTML перегенерирован: ${templates.length} шаблонов, ветка ${branch}`)
}
