/**
 * Замер реакции на «Стоп»: запускаем задачу, через N секунд просим остановиться,
 * меряем, сколько прошло до фактической остановки (§8.1 чек-листа QA).
 * node server/scripts/liveStop.js <moduleKey> <settings.json> [секундДоСтопа]
 */
import fs from 'node:fs'
import { startModuleTask, launchTask, stopModuleTask } from '../modules/registry.js'

const moduleKey = process.argv[2]
const settings = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))
const afterSec = Number(process.argv[4] || 25)

const { store, task } = startModuleTask(moduleKey, settings)
console.log(`задача ${task.id}`)
void launchTask(moduleKey, task, store)

await new Promise((r) => setTimeout(r, afterSec * 1000))
const t0 = Date.now()
await stopModuleTask(moduleKey, task.id)
console.log(`СТОП запрошен через ${afterSec} с работы`)

while (Date.now() - t0 < 120_000) {
  await new Promise((r) => setTimeout(r, 500))
  const t = await store.loadTask(task.id)
  if (['done', 'stopped', 'error'].includes(t?.status)) {
    console.log(`ОСТАНОВИЛАСЬ за ${((Date.now() - t0) / 1000).toFixed(1)} с · статус ${t.status}`)
    const last = (t.logs || [])[0]
    console.log('последняя строка:', last?.message)
    process.exit(0)
  }
}
console.log('НЕ ОСТАНОВИЛАСЬ за 120 с — «Стоп» игнорируется')
process.exit(1)
