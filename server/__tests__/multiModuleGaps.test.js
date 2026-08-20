/**
 * Дыры многомодульности (коммит 6a99c09, «аккаунт работает в нескольких модулях сразу»).
 *
 * Тесты НАМЕРЕННО красные там, где найден баг: каждый воспроизводит сценарий, который
 * ломает аккаунты, деньги или задачи. Зелёные — то, что проверено и работает.
 *
 * Разбор находок — в отчёте тестировщика; здесь только исполняемое доказательство.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  tryAcquireLocks, releaseTaskLocks, getAccountLock, forceReleaseAccount, markTaskDone,
} from '../lib/accountLocks.js'
import {
  beginAccountWork, endAccountWork, waitAccountWork, getAccountBusy, releaseTaskBusy,
} from '../lib/accountBusy.js'
import { canModuleUseAccount } from '../lib/accountStatus.js'
import { isAccountRunnable } from '../lib/protection.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const readServer = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8')

// ─────────────────────────────────────────────────────────────────────────────
// 1. Прогрев больше никем не защищён (ТЗ §3.3 «прогрев блокирует профиль»)
// ─────────────────────────────────────────────────────────────────────────────

test('прогрев нельзя ставить на аккаунт, который уже работает в боевом модуле', () => {
  // Порядок из жизни: сначала запустили рассылку, потом решили «а этот ещё и прогреть».
  assert.equal(tryAcquireLocks(['mm_w1'], 'mailing', 'mm_mail'), null)
  const err = tryAcquireLocks(['mm_w1'], 'warming', 'mm_warm')
  try {
    // До 20.08 это запрещал сам лок («один аккаунт = одна задача»). Теперь конфликт
    // считается только внутри ОДНОГО модуля, и прогрев спокойно встаёт поверх мейлинга:
    // непрогретый аккаунт одновременно шлёт холодные ЛС и «греется» — это спамблок.
    assert.ok(err, 'прогрев и боевой модуль не должны делить один аккаунт')
  } finally {
    releaseTaskLocks('mm_mail')
    releaseTaskLocks('mm_warm')
  }
})

test('рантайм-гейт боевых воркеров обязан быть модуль-зависимым (canModuleUseAccount)', () => {
  // Назначение (POST /tasks) спрашивает canModuleUseAccount(moduleKey, status) и warming
  // в боевой модуль не пускает…
  assert.equal(canModuleUseAccount('mailing', 'warming'), false)
  assert.equal(canModuleUseAccount('neuro-commenting', 'warming'), false)
  // …а воркеры в цикле спрашивают модуль-НЕЗАВИСИМЫЙ isAccountRunnable, для которого
  // warming — рабочий статус (иначе сам прогрев не смог бы взять свои аккаунты).
  assert.equal(isAccountRunnable('warming'), true)
  // Значит аккаунт, ставший 'warming' уже ПОСЛЕ старта боевой задачи, из неё не выпадает.
  // Комментарий workers.js:1231 утверждает обратное («входит в NON_RUNNABLE») — неправда.
  const src = readServer('modules/workers.js')
  assert.ok(
    src.includes('canModuleUseAccount'),
    'боевые воркеры должны сверяться с модуль-зависимым гейтом, а не с isAccountRunnable',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ручной разблок аккаунта сносит и держателя-прогрев (обход §12)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Правка 20.08: прогрев стал ЭКСКЛЮЗИВНЫМ держателем, поэтому пара [mailing, warming]
 * больше не собирается — исходный сценарий теста недостижим. Риск, однако, остался для
 * совместимых модулей: «Освободить» из-за зависшего мейлинга не должно сносить
 * комментинг, который в этот момент честно работает тем же аккаунтом.
 */
test('forceReleaseAccount снимает КОНКРЕТНОГО держателя, а не всю запись', () => {
  tryAcquireLocks(['mm_r1'], 'mailing', 'mm_r_mail')
  // Прогрев к занятому аккаунту не пустят — он эксклюзивный (правка 20.08).
  assert.match(String(tryAcquireLocks(['mm_r1'], 'warming', 'mm_r_warm')), /Прогрев не делит аккаунт/)
  assert.equal(tryAcquireLocks(['mm_r1'], 'neuro-commenting', 'mm_r_com'), null, 'совместимый модуль встаёт рядом')

  const lock = getAccountLock('mm_r1')
  assert.equal(lock.moduleKey, 'mailing', '«лицо» лока — первый держатель')
  assert.ok(!lock.holders.some((h) => h.moduleKey === 'warming'), 'прогрев к занятому аккаунту не пускают')

  try {
    forceReleaseAccount('mm_r1', { moduleKey: 'mailing' })
    assert.ok(
      getAccountLock('mm_r1')?.holders?.some((h) => h.moduleKey === 'neuro-commenting'),
      'разблок одного модуля не должен выбивать другой, который работает',
    )
    // Без указания модуля — прежнее поведение: снять всё (аварийный разблок админом).
    forceReleaseAccount('mm_r1')
    assert.equal(getAccountLock('mm_r1'), null)
  } finally {
    releaseTaskLocks('mm_r_mail')
    releaseTaskLocks('mm_r_warm')
    releaseTaskLocks('mm_r_com')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 3. Реестр занятости: слот не снимается на завершении задачи и не протухает
// ─────────────────────────────────────────────────────────────────────────────

test('завершение задачи обязано снимать её слоты занятости (releaseTaskBusy)', () => {
  const src = readServer('modules/workers.js')
  const at = src.indexOf('async function finalizeAccounts')
  assert.ok(at > 0, 'finalizeAccounts найдена')
  const body = src.slice(at, src.indexOf('\n}', at))
  // finalizeAccounts — единственный общий выход воркеров (её же зовёт finally в
  // launchWorker и stopWorker для задач на паузе/в очереди). Локи она снимает,
  // слот занятости — нет. Сам releaseTaskBusy подключён ТОЛЬКО к предстартовому
  // gateOnPreflight (registry.js:174), где слота ещё физически не существует.
  assert.ok(body.includes('releaseTaskBusy'), 'страховка releaseTaskBusy не подключена к завершению задачи')
})

test('пауза задачи должна сохранять локи — общий finally их снимает', () => {
  const src = readServer('modules/workers.js')
  // Воркер на выходе честно зовёт finalizeAccounts(ids, id, !!task.pauseRequested),
  // но finally в launchWorker зовёт finalizeAccounts(ids, taskId) — без третьего
  // аргумента, то есть paused=false → releaseTaskLocks. Паузa теряет аккаунты:
  // чужая задача того же модуля успевает их занять, и «Возобновить» падает с lockErr.
  assert.ok(src.includes('function launchWorker('), 'launchWorker найдена')
  assert.ok(
    !src.includes('await finalizeAccounts(task.settings?.accountIds || [], taskId)'),
    'страховочный finally снимает локи даже у задачи, поставленной на паузу (нет флага paused)',
  )
})

test('залипший слот занятости не протухает — аккаунт выпадает из всех модулей навсегда', () => {
  const t0 = 5_000_000
  // Задача взяла слот и умерла, не освободив его (падение воркера, break мимо
  // disconnectAccount, любой путь без endAccountWork).
  assert.equal(beginAccountWork('mm_leak', 'mailing', 'mm_dead', t0).ok, true)
  releaseTaskLocks('mm_dead')
  markTaskDone('mm_dead') // задача больше не «живая»: лок сняли, воркера нет

  // Час спустя другой модуль пробует взять тот же аккаунт.
  const gate = beginAccountWork('mm_leak', 'neuro-commenting', 'mm_live', t0 + 3600_000)
  try {
    // У локов есть самолечение (reconcileLocks) и ручной разблок в UI. У реестра
    // занятости нет ни того, ни другого, и getAccountBusy наружу не отдаётся —
    // оператор не увидит и не снимет. Лечится только рестартом процесса.
    assert.equal(gate.ok, true, 'слот мёртвой задачи должен освобождаться сам')
  } finally {
    releaseTaskBusy('mm_dead')
    releaseTaskBusy('mm_live')
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// 4. Сервисные модули ходят в сессию мимо реестра занятости
// ─────────────────────────────────────────────────────────────────────────────

test('снятие спамблока идёт мимо занятости — два действия в одну секунду', () => {
  const src = readServer('spamUnblock.js')
  assert.ok(src.includes('createClient'), 'модуль подключает сессию напрямую')
  // Пока мейлинг шлёт ЛС этим же аккаунтом, апелляция в @SpamBot открывает ВТОРУЮ
  // сессию тем же ключом. Ровно то, что реестр занятости и должен исключать.
  assert.ok(
    src.includes('accountBusy') || src.includes('accountRunner'),
    'spam-unblock должен занимать слот аккаунта, как остальные модули',
  )
})

test('легаси-воркер нейрокомментинга не участвует в реестре занятости', () => {
  const src = readServer('neuroCommenting/worker.js')
  assert.ok(src.includes('createClient'), 'легаси-воркер подключается напрямую')
  // У него свой путь завершения (releaseTaskLocks на строке 325) — releaseTaskBusy
  // там нет, beginAccountWork/waitAccountWork тоже: физика «одно действие за раз»
  // его не касается совсем.
  assert.ok(
    /beginAccountWork|waitAccountWork|connectAccount\(/.test(src),
    'легаси-воркер обязан занимать слот аккаунта наравне с новыми',
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Зелёные: что проверено и работает как задумано
// ─────────────────────────────────────────────────────────────────────────────

test('карусельный гейт + connectAccount: повторный вход своей задачи мгновенный', async () => {
  // Карусель занимает слот сама (beginAccountWork), затем connectAccount зовёт
  // waitAccountWork той же задачей — не должно быть самоблокировки.
  assert.equal(beginAccountWork('mm_reentry', 'mass-react', 'mm_t1').ok, true)
  const waited = await waitAccountWork('mm_reentry', 'mass-react', 'mm_t1', { timeoutMs: 50 })
  assert.ok(waited < 30, `повторный вход должен быть мгновенным, ждали ${waited}мс`)
  assert.equal(getAccountBusy('mm_reentry').taskId, 'mm_t1')
  endAccountWork('mm_reentry', 'mm_t1')
})

test('слот по таймауту НЕ отбирается — ждущий получает отказ, владелец продолжает', async () => {
  // Раньше waitAccountWork по таймауту переписывал владельца. Это ломало саму идею
  // реестра: прежний владелец продолжал работать своим живым клиентом, и два модуля
  // действовали одним аккаунтом одновременно — ровно в мейлинге, где это и приводило
  // к спамблокам. Теперь ожидающий получает отказ и берёт следующую цель/аккаунт.
  assert.equal(beginAccountWork('mm_steal', 'neuro-commenting', 'mm_owner').ok, true)
  await assert.rejects(
    () => waitAccountWork('mm_steal', 'mailing', 'mm_thief', { timeoutMs: 0 }),
    (err) => err.code === 'ACCOUNT_BUSY',
  )
  assert.equal(getAccountBusy('mm_steal').taskId, 'mm_owner', 'слот остался у владельца')
  // Владелец доработал и отпустил — слот свободен для следующего.
  endAccountWork('mm_steal', 'mm_owner')
  assert.equal(getAccountBusy('mm_steal'), null)
  releaseTaskBusy('mm_thief')
})
