/**
 * Живой прогон любого модуля тем же путём, каким его запускает API (QA-прогон 22.08).
 * node server/scripts/liveRun.js <moduleKey> <settings.json> [минутОжидания]
 */
import fs from 'node:fs'
import { startModuleTask, launchTask } from '../modules/registry.js'

const moduleKey = process.argv[2]
const settings = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const minutes = Number(process.argv[4] || 6)

const { store, task } = startModuleTask(moduleKey, settings)
console.log(`задача ${task.id} · модуль ${moduleKey}`)
void launchTask(moduleKey, task, store)

const started = Date.now()
let seen = 0
while (Date.now() - started < minutes * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 4000))
  const t = await store.loadTask(task.id)
  const logs = (t?.logs || []).slice().reverse()
  for (const l of logs.slice(seen)) console.log(`  [${l.level}] ${(l.account || '—').padEnd(16)} ${l.message}`)
  seen = logs.length
  if (['done', 'stopped', 'error'].includes(t?.status)) { console.log('СТАТУС:', t.status); break }
}
const fin = await store.loadTask(task.id)
console.log('ИТОГ:', fin?.status, '| прогресс', JSON.stringify(fin?.progress))
process.exit(0)
