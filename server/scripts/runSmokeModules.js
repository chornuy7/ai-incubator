/**
 * Прогон модулей на реальной сессии (dev/test).
 * node server/scripts/runSmokeModules.js
 */
import { MODULE_DEFS } from '../modules/registry.js'

const API = process.env.API_URL || 'http://localhost:3001'
const ACCOUNT = 'acc_35fe802535ad'
const CHANNEL = 'markettwits'
const CHAT_INVITE = 'https://t.me/+6zx0hRaS4IY0Nzgy'

const base = {
  accountIds: [ACCOUNT],
  aiProtection: true,
  protectionLevel: 1,
  delayPreset: 1,
  delays: {
    action: [10, 20],
    join: [15, 25],
    comment: [10, 20],
    floodWait: 120,
    floodQuarantine: 3,
  },
}

const runs = [
  { key: 'ggr', settings: { ...base, maxActions: 1 } },
  { key: 'parsing', settings: { ...base, keywords: ['markettwits', 'crypto'], maxActions: 5, limit: 5 } },
  { key: 'mass-looking', settings: { ...base, targets: [CHANNEL], maxActions: 2, maxPerAccount: 2 } },
  { key: 'mass-react', settings: { ...base, targets: [CHANNEL], maxActions: 2, maxPerAccount: 1, probability: 80, emojis: ['👍', '🔥'] } },
  { key: 'neuro-commenting', settings: { ...base, targets: [CHANNEL], channels: [CHANNEL], maxActions: 1, maxPerAccount: 1, maxComments: 1, probability: 100, promptIndex: 0 } },
  { key: 'neuro-chatting', settings: { ...base, targets: [CHAT_INVITE], maxActions: 1, maxPerAccount: 1, probability: 100, promptIndex: 0 } },
  { key: 'parsing-users', settings: { ...base, targets: [CHAT_INVITE], maxActions: 20, limit: 20 } },
  { key: 'warming', settings: { ...base, maxActions: 2, maxPerAccount: 2 } },
]

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.json()
}

async function get(path) {
  const res = await fetch(`${API}${path}`)
  return res.json()
}

async function waitTask(moduleKey, taskId, maxSec = 180) {
  const start = Date.now()
  while (Date.now() - start < maxSec * 1000) {
    const data = await get(`/api/modules/${moduleKey}/tasks/${taskId}`)
    if (!data.ok) throw new Error(data.error)
    const t = data.task
    const lastLog = t.logs?.[0]?.message ?? ''
    process.stdout.write(`\r  [${t.status}] ${lastLog.slice(0, 60).padEnd(60)}`)
    if (['done', 'stopped', 'error'].includes(t.status)) {
      console.log('')
      return t
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error('timeout')
}

console.log('Account:', ACCOUNT)
console.log('Channel:', CHANNEL)
console.log('Chat:', CHAT_INVITE)
console.log('Modules:', Object.keys(MODULE_DEFS).length)
console.log('---')

const summary = []

for (const run of runs) {
  console.log(`\n▶ ${run.key}`)
  try {
    const created = await post(`/api/modules/${run.key}/tasks`, { settings: run.settings })
    if (!created.ok) {
      console.log('  FAIL start:', created.error)
      summary.push({ key: run.key, status: 'fail', error: created.error })
      continue
    }
    const task = await waitTask(run.key, created.task.id)
    const ok = task.status === 'done'
    summary.push({
      key: run.key,
      status: task.status,
      actions: task.progress?.actionsDone ?? 0,
      results: task.results?.length ?? 0,
      lastLog: task.logs?.[0]?.message,
    })
    console.log(`  ${ok ? 'OK' : task.status}: actions=${task.progress?.actionsDone ?? 0}, results=${task.results?.length ?? 0}`)
  } catch (e) {
    console.log('  ERROR:', e.message)
    summary.push({ key: run.key, status: 'error', error: e.message })
  }
}

console.log('\n=== SUMMARY ===')
for (const s of summary) {
  console.log(`${s.key.padEnd(20)} ${s.status.padEnd(8)} ${s.actions ?? ''} ${s.results ?? ''} ${s.error || s.lastLog || ''}`)
}
