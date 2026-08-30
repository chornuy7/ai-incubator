#!/usr/bin/env node
/**
 * Привратник регламента: не даёт писать в файлы репозитория, пока для ТЕКУЩЕЙ ВЕТКИ не
 * загружен скилл `task-workflow`.
 *
 * Зачем хук, а не правило в CLAUDE.md. Правило «загрузи скилл перед правкой» держится на том,
 * что Claude сам себя проверит, — а именно эта проверка и не срабатывает: просьба звучит
 * мелочью («поправь цвет кнопки»), скилл не грузится, правка уходит в `main`, и шаблоны
 * остановки опаздывают. Хук выполняет harness, а не модель, поэтому обойти его нельзя.
 *
 * Почему отметка привязана к ВЕТКЕ, а не к сессии. Ветка — это и есть задача: у неё свой ключ
 * в Jira и свой прогресс по статусам. Сессий на одну ветку может быть много, а веток в одной
 * сессии — несколько. Отметка на сессии заставляла бы грузить скилл заново после каждого
 * перезапуска и молчала бы при переключении на чужую ветку.
 *
 * Переезд отметки. `git checkout -b` уносит незакоммиченную работу из `main` в новую ветку —
 * это ровно то, что предписывает шаблон «работа начата в main». Задача при этом не меняется,
 * поэтому отметка едет следом, а из `main` убирается: там она больше ничего не охраняет.
 *
 * Статус задачи в отметке. Хук в Jira не ходит — на каждую правку это сеть и задержка, а без
 * сети привратник бы падал. Статус кладёт сюда Claude, когда сам его прочитал, и хук сверяет
 * ОФЛАЙН ровно одно расхождение, которое для этого не нужно: задача в `Done`, а файлы всё ещё
 * меняются. `Done` — единственный статус, где работа уже ПРИНЯТА; правка после него означает
 * либо новую работу (тогда нужна новая задача), либо незаявленную регрессию.
 *
 * Проверять так же `Ai Testing` и `Human Testing` было бы неверно: это рабочие состояния, правка
 * по замечаниям тестировщика там — обычный ход дела. Предупреждение, которое срабатывает на
 * нормальной работе, просто приучает его пропускать.
 *
 * Режимы:
 *   check  — из хука, читает stdin с JSON вызова инструмента (по умолчанию)
 *   mark   — отметка текущей ветке: node .claude/hooks/workflow-gate.mjs mark MR-252 "In Progress"
 *            (статус необязателен; если опущен — прежний сохраняется)
 *   status — показать состояние (ничего не меняет)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve, relative, isAbsolute } from 'node:path'

const MODE = process.argv[2] || 'check'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()

/**
 * Разрешить. Хук, который падает, не должен останавливать работу, поэтому все неожиданности
 * ведут сюда. `note` — предупреждение: уходит и человеку (`systemMessage`), и в контекст модели
 * (`additionalContext`), иначе Claude его не увидит и не среагирует.
 */
function allow(note) {
  if (note) {
    process.stdout.write(JSON.stringify({
      systemMessage: note,
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: note },
    }) + '\n')
  }
  process.exit(0)
}

/**
 * Задача отдана на проверку. Правка тут не запрещена — по замечаниям и правят, — но статус
 * обязан вернуться в `In Progress`: пока он говорит «проверяй», тестировщик проверяет код,
 * которого уже нет. Вместе со статусом пишется ПРИЧИНА отката: через неделю «почему задача
 * дважды падала из Human Testing» восстанавливается только из неё.
 */
const TESTING = ['Ai Testing', 'Human Testing']

/** Работа принята человеком. Правка — либо новая задача, либо незаявленная регрессия. */
const ACCEPTED = ['Done']

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }) + '\n')
  process.exit(0)
}

let ROOT
try {
  ROOT = git('rev-parse', '--show-toplevel')
} catch {
  allow() // не git-репозиторий — регламент тут не при чём
}

const STATE = resolve(ROOT, '.claude', '.workflow-state.json')

function branch() {
  try {
    return git('rev-parse', '--abbrev-ref', 'HEAD')
  } catch {
    return null
  }
}

function readState() {
  try {
    return JSON.parse(readFileSync(STATE, 'utf8'))
  } catch {
    return { branches: {} }
  }
}

function writeState(s) {
  mkdirSync(dirname(STATE), { recursive: true })
  writeFileSync(STATE, JSON.stringify(s, null, 2) + '\n', 'utf8')
}

/**
 * Отметка для ветки с учётом переезда из `main`. Возвращает запись или null.
 * Переезд делается ЛЕНИВО, на первой же проверке в новой ветке: ловить сам `checkout -b`
 * нечем — хук висит на записи в файл, а не на git.
 */
function entryFor(br, { migrate } = { migrate: true }) {
  const st = readState()
  st.branches = st.branches || {}
  if (st.branches[br]) return st.branches[br]

  const BASE = ['main', 'master']
  if (migrate && !BASE.includes(br)) {
    const from = BASE.find((b) => st.branches[b])
    if (from) {
      st.branches[br] = { ...st.branches[from], movedFrom: from }
      delete st.branches[from]
      writeState(st)
      return st.branches[br]
    }
  }
  return null
}

// ── mark / status ────────────────────────────────────────────────────────────
if (MODE === 'mark') {
  const br = branch()
  if (!br) { console.error('не удалось определить ветку'); process.exit(1) }
  const st = readState()
  st.branches = st.branches || {}
  const prev = st.branches[br] || {}
  // Статус необязателен: повторная отметка не должна молча стирать уже прочитанный статус.
  const status = process.argv[4] || prev.status || null
  st.branches[br] = {
    loaded: true,
    task: process.argv[3] || prev.task || null,
    status,
    statusAt: status && status !== prev.status ? new Date().toISOString() : (prev.statusAt || null),
    at: new Date().toISOString(),
  }
  writeState(st)
  console.log(`отметка поставлена: ${br}${st.branches[br].task ? ` (${st.branches[br].task}` : ''}${status ? `, статус ${status})` : st.branches[br].task ? ')' : ''}`)
  process.exit(0)
}

if (MODE === 'rollback') {
  const br = branch()
  if (!br) { console.error('не удалось определить ветку'); process.exit(1) }
  const reason = process.argv[4]
  if (!reason) {
    console.error('нужна причина: rollback <KEY> "<причина отката>"')
    console.error('Причина обязательна: откат без объяснения превращает историю задачи в череду')
    console.error('необъяснённых падений, по которой уже не понять, что именно ломалось.')
    process.exit(1)
  }
  const st = readState()
  st.branches = st.branches || {}
  const prev = st.branches[br] || {}
  const history = prev.rollbacks || []
  history.push({ from: prev.status || null, reason, at: new Date().toISOString() })
  st.branches[br] = {
    ...prev,
    loaded: true,
    task: process.argv[3] || prev.task || null,
    status: 'In Progress',
    statusAt: new Date().toISOString(),
    at: new Date().toISOString(),
    rollbacks: history,
  }
  writeState(st)
  console.log(`откат записан: ${prev.status || '—'} → In Progress`)
  console.log(`причина: ${reason}`)
  console.log(`всего откатов по ветке: ${history.length}`)
  console.log('Не забудь перевести статус и оставить комментарий с причиной в самой Jira.')
  process.exit(0)
}

if (MODE === 'status') {
  const br = branch()
  const st = readState()
  const e = (st.branches || {})[br]
  console.log(`ветка: ${br}`)
  if (!e) {
    console.log('скилл отмечен: НЕТ')
  } else {
    console.log(`скилл отмечен: да${e.task ? `, задача ${e.task}` : ''}${e.movedFrom ? `, переехала из ${e.movedFrom}` : ''}`)
    const age = e.statusAt ? Math.round((Date.now() - Date.parse(e.statusAt)) / 36e5) : null
    console.log(`статус: ${e.status || 'не записан'}${age !== null ? ` (записан ${age} ч назад)` : ''}`)
    if (TESTING.includes(e.status)) console.log(`⚠ правка при «${e.status}» требует отката в In Progress с указанием причины`)
    if (ACCEPTED.includes(e.status)) console.log('⚠ работа принята: правка — повод остановиться и спросить человека')
    for (const r of e.rollbacks || []) {
      console.log(`откат: ${r.from || '—'} → In Progress · ${r.at.slice(0, 16).replace('T', ' ')} · ${r.reason}`)
    }
  }
  const others = Object.keys(st.branches || {}).filter((b) => b !== br)
  if (others.length) console.log(`другие ветки с отметкой: ${others.join(', ')}`)
  process.exit(0)
}

// ── check (хук) ──────────────────────────────────────────────────────────────
let payload = ''
try {
  payload = readFileSync(0, 'utf8')
} catch {
  allow()
}

let file
try {
  file = JSON.parse(payload)?.tool_input?.file_path
} catch {
  allow()
}
if (!file) allow()

// Файлы вне репозитория (скретчпад, временные) регламент не охраняет.
const abs = isAbsolute(file) ? file : resolve(process.cwd(), file)
const rel = relative(ROOT, abs)
if (rel.startsWith('..') || isAbsolute(rel)) allow()

// Само состояние привратника и его скрипт — не предмет регламента.
if (abs === STATE) allow()

const br = branch()
if (!br) allow()

const entry = entryFor(br)
if (entry) {
  const key = entry.task || '<KEY>'
  // Правка во время проверки — задача обязана вернуться в In Progress с указанием причины.
  if (TESTING.includes(entry.status)) {
    allow(
      `⚠ ОТКАТ СТАТУСА: ${key} в «${entry.status}», но идёт правка ${rel}.\n` +
      `Пока статус говорит «проверяй», тестировщик проверяет код, которого уже нет.\n` +
      `Что сделать по порядку:\n` +
      `  1) перевести ${key} в In Progress в Jira;\n` +
      `  2) комментарием указать ПРИЧИНУ отката — что и почему меняется после сдачи;\n` +
      `  3) записать это здесь:\n` +
      `     node .claude/hooks/workflow-gate.mjs rollback ${key} "<причина>"`,
    )
  }
  // Работа принята — молча продолжать нельзя.
  if (ACCEPTED.includes(entry.status)) {
    allow(
      `⚠ Расхождение с Jira: ${key} в статусе «${entry.status}», но идёт правка ${rel}.\n` +
      `«Done» означает, что работа принята человеком. Правка после этого — либо новая работа ` +
      `(нужна отдельная задача), либо регрессия, о которой никто не знает.\n` +
      `Что сделать: остановиться и спросить человека, а не откатывать статус самому.`,
    )
  }
  allow()
}

deny(
  `Регламент Myrmex: скилл task-workflow не загружен для ветки «${br}» — правка ${rel} заблокирована.\n` +
  `Что сделать: вызови Skill(task-workflow), пройди гейт (Jira → задача → ветка), затем отметь загрузку:\n` +
  `  node .claude/hooks/workflow-gate.mjs mark <KEY>\n` +
  `Отметка привязана к ветке: при переходе с main на feat/* она переедет сама, при переключении между ветками проверится заново.`,
)
