#!/usr/bin/env node
/**
 * npm run sync — подтянуть свежее ПЕРЕД началом работы над задачей (правило в CLAUDE.md).
 *
 * Тянет по очереди: текущую ветку от её upstream, затем `main` из origin в текущую ветку.
 * Смысл в порядке: сначала догоняем свою ветку, потом вливаем общий main — так конфликт,
 * если он есть, всплывает СРАЗУ и на чистом дереве, а не через час работы поверх кода,
 * который в main уже переписали.
 *
 * Грязное дерево — стоп, без автостэша. Стэш поверх чужой незакоммиченной работы (а в этом
 * репозитории две дорожки в одном рабочем каталоге) разваливается ровно тогда, когда его
 * труднее всего разобрать: конфликты уезжают в `git stash pop` и уже не видно, где чей код.
 * Лучше честно остановиться и сказать, что закоммитить.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const tryGit = (...args) => { try { return git(...args) } catch { return null } }
const say = (s = '') => process.stdout.write(s + '\n')

const MAIN = 'main'

// ── 0. Инструменты навигации ────────────────────────────────────────────────
// Оба обязательны для всех, а не «желательны»: без них навигация по коду
// скатывается к перебору грепом, и агент читает файлы целиком вместо символов.
// Проверка стоит здесь, потому что sync — обязательный первый шаг любой задачи
// (CLAUDE.md, гейт): не установлено — задача не начинается.
//
// Роли разведены и не пересекаются: Serena отвечает на вопросы про ОДИН символ
// (определение, ссылки, правка) через TypeScript language server;
// codebase-memory — про СВЯЗИ и общую картину (граф, архитектура, не-TS файлы).
const missing = []

try {
  execFileSync('serena', ['--version'], { encoding: 'utf8', stdio: 'pipe' })
} catch {
  missing.push({
    name: 'Serena',
    what: 'символьная навигация по TypeScript (find_symbol, ссылки, правка)',
    how: ['uv tool install -p 3.13 serena-agent', 'serena init'],
    note: 'Нет uv — сначала он: https://docs.astral.sh/uv/getting-started/installation/',
  })
}

// codebase-memory-mcp приезжает как devDependency, поэтому достаточно проверить
// бинарник в node_modules — это мгновенно, в отличие от запуска через npx.
const cbmBin = ['codebase-memory-mcp', 'codebase-memory-mcp.cmd']
  .some((f) => existsSync(join('node_modules', '.bin', f)))
if (!cbmBin) {
  missing.push({
    name: 'codebase-memory-mcp',
    what: 'граф кода: архитектура, связи, поиск за пределами TypeScript',
    how: ['npm install'],
    note: 'Он в devDependencies — обычно достаточно поставить зависимости.',
  })
}

if (missing.length) {
  say('')
  for (const m of missing) {
    say(`  ✗ ${m.name} не установлена — ${m.what}.\n`)
    say('    Установка:\n')
    for (const cmd of m.how) say('        ' + cmd)
    say('')
    if (m.note) say('    ' + m.note + '\n')
  }
  say('    Оба работают локально: транспорт stdio, то есть отдельные процессы на')
  say('    этой машине, без сети. Конфиг лежит в .mcp.json и подхватывается сам.\n')
  process.exit(1)
}

// ── 1. Дерево должно быть чистым ────────────────────────────────────────────
const dirty = git('status', '--porcelain', '--untracked-files=no')
if (dirty) {
  say('\n  ✗ Есть незакоммиченные изменения — сначала закоммить или убери их:\n')
  for (const line of dirty.split('\n')) say('      ' + line)
  say('\n    Мержить поверх них нельзя: git откажется, а автостэш перемешает')
  say('    твою работу с чужой. Закоммить своё — и запусти снова.\n')
  process.exit(1)
}

// ── 2. Свежие ссылки ────────────────────────────────────────────────────────
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')
say(`\n  Ветка: ${branch}`)
say('  Забираю свежие ссылки (git fetch --all --prune)…')
git('fetch', '--all', '--prune')

// ── 3. Текущая ветка от своего upstream ─────────────────────────────────────
const upstream = tryGit('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
if (!upstream) {
  say(`  · у ${branch} нет upstream — пропускаю подтягивание ветки`)
} else {
  const behind = git('rev-list', '--count', `HEAD..${upstream}`)
  if (behind === '0') {
    say(`  · ${branch} уже в уровень с ${upstream}`)
  } else {
    say(`  · ${branch} отстаёт от ${upstream} на ${behind} — тяну (--ff-only)…`)
    try {
      git('merge', '--ff-only', upstream)
      say(`  ✓ ${branch} обновлена`)
    } catch {
      say(`\n  ✗ ${branch} разошлась с ${upstream} — fast-forward невозможен.`)
      say('    Разберись вручную (rebase или merge) и запусти снова.\n')
      process.exit(1)
    }
  }
}

// ── 4. main в текущую ветку ─────────────────────────────────────────────────
if (branch === MAIN) {
  say(`  · уже на ${MAIN} — отдельного влития не нужно`)
} else {
  const behindMain = git('rev-list', '--count', `HEAD..origin/${MAIN}`)
  if (behindMain === '0') {
    say(`  · origin/${MAIN} уже влит`)
  } else {
    say(`  · отстаём от origin/${MAIN} на ${behindMain} — вливаю…`)
    try {
      git('merge', '--no-edit', `origin/${MAIN}`)
      say(`  ✓ origin/${MAIN} влит в ${branch}`)
    } catch {
      say(`\n  ✗ Конфликт при влитии origin/${MAIN}. Файлы:\n`)
      for (const f of (tryGit('diff', '--name-only', '--diff-filter=U') || '').split('\n').filter(Boolean)) say('      ' + f)
      say('\n    Разреши конфликты, `git commit`, и только потом берись за задачу.\n')
      process.exit(1)
    }
  }
}

say('\n  ✓ Готово — можно браться за задачу.\n')
