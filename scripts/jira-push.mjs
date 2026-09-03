/**
 * Заливка бэклога (ТЗ 04.08) в Jira проекта MR через REST API.
 * Данные — из jira-import-2026-08-04.csv. Эпики → Workstream (10039), задачи → Task (10040)
 * с parent на Workstream. Описание — ADF. Приоритет и метки — в labels (prio-*, tz-04-08).
 *
 * Креды из .env: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN (не коммитятся).
 * Запуск: node --env-file=.env scripts/jira-push.mjs test   — 1 эпик + 1 задача (проверка)
 *         node --env-file=.env scripts/jira-push.mjs         — всё
 */
import fs from 'node:fs'

const base = process.env.JIRA_BASE_URL, email = process.env.JIRA_EMAIL, token = process.env.JIRA_API_TOKEN
if (!base || !email || !token) { console.error('нет JIRA_* в .env'); process.exit(1) }
const auth = 'Basic ' + Buffer.from(email + ':' + token).toString('base64')
const H = { Authorization: auth, 'Content-Type': 'application/json', Accept: 'application/json' }
const TEST = process.argv.includes('test')
const EPIC_TYPE = '10039'   // Workstream
const TASK_TYPE = '10040'   // Task

// ── парсер CSV (учитывает кавычки и "" внутри) ──
function parseCSV(text) {
  const rows = []; let row = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') q = false
      else cur += c
    } else if (c === '"') q = true
    else if (c === ',') { row.push(cur); cur = '' }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = '' }
    else if (c === '\r') { /* skip */ }
    else cur += c
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row) }
  return rows
}

const adf = (t) => ({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: String(t || ' ') }] }] })
const labelsOf = (pri, raw) => [...new Set((`prio-${String(pri).toLowerCase()} ${raw}`).split(/\s+/).filter(Boolean).map((s) => s.replace(/[^\w-]/g, '')))]

async function createIssue(fields) {
  const r = await fetch(base + '/rest/api/3/issue', { method: 'POST', headers: H, body: JSON.stringify({ fields }) })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(r.status + ' ' + JSON.stringify(j.errors || j.errorMessages || j).slice(0, 200))
  return j.key
}

const rows = parseCSV(fs.readFileSync('jira-import-2026-08-04.csv', 'utf8'))
const header = rows.shift()
const idx = Object.fromEntries(header.map((h, i) => [h.trim(), i]))
const data = rows.filter((r) => r.length >= 5).map((r) => ({
  type: r[idx['Issue Type']], summary: r[idx.Summary], desc: r[idx.Description],
  epic: r[idx['Epic Link']], pri: r[idx.Priority], labels: r[idx.Labels],
}))
const epics = data.filter((d) => d.type === 'Epic')
const tasks = data.filter((d) => d.type === 'Task')

async function updateIssue(key, fields) {
  const r = await fetch(base + '/rest/api/3/issue/' + key, { method: 'PUT', headers: H, body: JSON.stringify({ fields }) })
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 150))
}

// Уже созданные при тесте (удалить нельзя — 403): переиспользуем.
const EXISTING_EPIC = { 'Процесс и Jira': 'MR-2' }
const REUSE_TASK = 'MR-3' // тест-задача → станет первой реальной

const epicKey = { ...EXISTING_EPIC }   // epic name → key
let created = 0, reused = 0

// 1. Эпики (Workstream) — пропускаем уже существующие.
for (const e of epics) {
  if (epicKey[e.summary]) { console.log('EPIC ↺ ' + epicKey[e.summary] + '  ' + e.summary + ' (уже есть)'); continue }
  const key = await createIssue({ project: { key: 'MR' }, issuetype: { id: EPIC_TYPE }, summary: e.summary, description: adf(e.desc), labels: labelsOf(e.pri, e.labels) })
  epicKey[e.summary] = key; created++
  console.log('EPIC ✅ ' + key + '  ' + e.summary)
}

// 2. Задачи (Task). Первую — переиспользуем MR-3 (edit), остальные — создаём.
let first = true
for (const t of tasks) {
  const parent = epicKey[t.epic]
  const fields = { summary: t.summary, description: adf(t.desc), labels: labelsOf(t.pri, t.labels) }
  if (parent) fields.parent = { key: parent }
  if (first) {
    first = false
    try {
      await updateIssue(REUSE_TASK, fields)
      reused++; console.log('  task ↺ ' + REUSE_TASK + '  [' + t.pri + '] ' + t.summary + '  (переиспользован тест)')
      continue
    } catch (e) { console.log('  (edit MR-3 не удался: ' + e.message + ' — создаю новую)') }
  }
  const key = await createIssue({ project: { key: 'MR' }, issuetype: { id: TASK_TYPE }, ...fields })
  created++
  console.log('  task ✅ ' + key + '  [' + t.pri + '] ' + t.summary + (parent ? '  → ' + parent : ''))
}

console.log(`\nИТОГО: создано ${created}, переиспользовано ${reused}. Эпиков ${epics.length}, задач ${tasks.length}.`)
