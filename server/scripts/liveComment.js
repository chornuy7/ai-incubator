/**
 * Живая проверка нейрокомментинга тем же путём, каким его запускает API.
 * node server/scripts/liveComment.js <accountId> [probability]
 */
import { startModuleTask, launchTask } from '../modules/registry.js'

const accountId = process.argv[2]
const probability = Number(process.argv[3] || 100)

const { store, task } = startModuleTask('neuro-commenting', {
  accountIds: [accountId],
  targets: ['ai_incubator_test'],
  channels: ['ai_incubator_test'],
  probability,
  aiProtection: true,
  protectionLevel: 1,
  delayPreset: 1,
  postFilter: 0,
  postWindow: 5,
  maxActions: 1,
  maxPerAccount: 1,
  maxComments: 1,
  promptIndex: 0,
  delays: { action: [5, 10], join: [60, 70], comment: [10, 20], floodWait: 120, floodQuarantine: 3 },
})
console.log('задача', task.id)
void launchTask('neuro-commenting', task, store)

const started = Date.now()
let seen = 0
while (Date.now() - started < 6 * 60 * 1000) {
  await new Promise((r) => setTimeout(r, 4000))
  const t = await store.loadTask(task.id)
  const logs = (t?.logs || []).slice().reverse()
  for (const l of logs.slice(seen)) console.log(`  [${l.level}] ${(l.account || '—').padEnd(14)} ${l.message}`)
  seen = logs.length
  if (['done', 'stopped', 'error'].includes(t?.status)) { console.log('СТАТУС:', t.status); break }
}
process.exit(0)
