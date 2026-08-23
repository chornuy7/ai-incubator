/** Пауза → продолжить: сохраняется ли прогресс и счётчики (§8.2 чек-листа QA). */
import fs from 'node:fs'
import { startModuleTask, launchTask, pauseModuleTask, resumeModuleTask } from '../modules/registry.js'

const moduleKey = process.argv[2]
const settings = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const afterSec = Number(process.argv[4] || 40)

const { store, task } = startModuleTask(moduleKey, settings)
console.log(`задача ${task.id}`)
void launchTask(moduleKey, task, store)

await new Promise((r) => setTimeout(r, afterSec * 1000))
await pauseModuleTask(moduleKey, task.id)
let t = await store.loadTask(task.id)
for (let i = 0; i < 40 && t?.status === 'running'; i++) { await new Promise((r) => setTimeout(r, 500)); t = await store.loadTask(task.id) }
const наПаузе = JSON.stringify(t?.progress)
console.log(`ПАУЗА · статус ${t?.status} · прогресс ${наПаузе} · монет потрачено ${t?.spentCoins ?? 0}`)

await resumeModuleTask(moduleKey, task.id)
await new Promise((r) => setTimeout(r, 4000))
t = await store.loadTask(task.id)
console.log(`ПРОДОЛЖЕНО · статус ${t?.status} · прогресс ${JSON.stringify(t?.progress)}`)
console.log(наПаузе === JSON.stringify(t?.progress) ? '✅ прогресс сохранён' : '⚠️ прогресс изменился при возобновлении (мог успеть сделать действие)')
process.exit(0)
