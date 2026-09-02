import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  STATUS,
  ALL_STATUSES,
  normalizeStatus,
  isRunnable,
  canAssign,
  canTransition,
  buildStatusPatch,
  isStatusExpired,
  nextStatusAfterExpiry,
  canModuleUseAccount,
  TERMINAL,
} from '../lib/accountStatus.js'

test('набор статусов из ТЗ §3.3', () => {
  assert.deepEqual(
    [...ALL_STATUSES].sort(),
    ['active', 'floodwait', 'invalid', 'pause', 'quarantine', 'reauth', 'spamblock', 'warming'].sort(),
  )
})

test('normalizeStatus: legacy → канон', () => {
  assert.equal(normalizeStatus('working'), STATUS.ACTIVE) // working = факт лока, не статус
  assert.equal(normalizeStatus('frozen'), STATUS.QUARANTINE)
  assert.equal(normalizeStatus('valid'), STATUS.ACTIVE)
  assert.equal(normalizeStatus(''), STATUS.ACTIVE)
  assert.equal(normalizeStatus(undefined), STATUS.ACTIVE)
  assert.equal(normalizeStatus('QUARANTINE'), STATUS.QUARANTINE) // регистр
  assert.equal(normalizeStatus('чтотонепонятное'), STATUS.ACTIVE) // fallback
})

test('isRunnable / canAssign', () => {
  assert.equal(isRunnable(STATUS.ACTIVE), true)
  assert.equal(isRunnable('working'), true) // legacy working → active
  for (const s of ['warming', 'pause', 'floodwait', 'quarantine', 'spamblock', 'reauth', 'invalid']) {
    assert.equal(isRunnable(s), false, `${s} должен быть нерабочим`)
    assert.equal(canAssign(s), false)
  }
})

test('canTransition: разрешённые и запрещённые', () => {
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.WARMING), true)
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.FLOODWAIT), true)
  assert.equal(canTransition(STATUS.FLOODWAIT, STATUS.ACTIVE), true)
  assert.equal(canTransition(STATUS.SPAMBLOCK, STATUS.QUARANTINE), true)
  assert.equal(canTransition(STATUS.PAUSE, STATUS.ACTIVE), true)
  assert.equal(canTransition(STATUS.ACTIVE, STATUS.ACTIVE), true) // тождественный
  // invalid — терминальный
  assert.equal(canTransition(STATUS.INVALID, STATUS.ACTIVE), false)
  // pause выходит только в active
  assert.equal(canTransition(STATUS.PAUSE, STATUS.WARMING), false)
})

test('canModuleUseAccount: прогрев блокирует другие модули (§3.3)', () => {
  // прогрев может брать active и warming
  assert.equal(canModuleUseAccount('warming', 'active'), true)
  assert.equal(canModuleUseAccount('warming', 'warming'), true)
  assert.equal(canModuleUseAccount('warming', 'quarantine'), false)
  // другие модули НЕ берут warming-аккаунт
  assert.equal(canModuleUseAccount('neuro-commenting', 'warming'), false)
  assert.equal(canModuleUseAccount('parsing', 'warming'), false)
  // рабочий active — можно всем
  assert.equal(canModuleUseAccount('neuro-commenting', 'active'), true)
  assert.equal(canModuleUseAccount('parsing', 'working'), true) // legacy working → active
  // нерабочие — никому (кроме warming-исключения выше)
  for (const s of ['pause', 'floodwait', 'quarantine', 'spamblock', 'reauth', 'invalid']) {
    assert.equal(canModuleUseAccount('neuro-commenting', s), false, `${s} не должен назначаться`)
  }
})

test('TERMINAL содержит invalid', () => {
  assert.equal(TERMINAL.has(STATUS.INVALID), true)
  assert.equal(TERMINAL.has(STATUS.ACTIVE), false)
})

test('buildStatusPatch: валидный переход даёт полный патч', () => {
  const patch = buildStatusPatch({ status: 'active' }, STATUS.FLOODWAIT, {
    code: 'FLOOD_WAIT_420',
    until: 1_000_000,
    initiator: 'system',
  })
  assert.equal(patch.status, STATUS.FLOODWAIT)
  assert.equal(patch.prevStatus, STATUS.ACTIVE)
  assert.equal(patch.statusCode, 'FLOOD_WAIT_420')
  assert.equal(patch.statusReason, 'FLOOD_WAIT_420')
  assert.equal(patch.statusUntil, 1_000_000)
  assert.equal(patch.statusBy, 'system')
  assert.equal(typeof patch.statusSince, 'number')
})

test('buildStatusPatch: legacy-статус нормализуется в prevStatus', () => {
  const patch = buildStatusPatch({ status: 'working' }, STATUS.PAUSE, { initiator: 'op1' })
  assert.equal(patch.prevStatus, STATUS.ACTIVE) // working → active
  assert.equal(patch.status, STATUS.PAUSE)
  assert.equal(patch.statusBy, 'op1')
})

test('buildStatusPatch: недопустимый переход бросает', () => {
  assert.throws(
    () => buildStatusPatch({ status: 'invalid' }, STATUS.ACTIVE),
    /ILLEGAL_TRANSITION:invalid->active/,
  )
})

test('isStatusExpired: только временные статусы и по времени', () => {
  assert.equal(isStatusExpired({ status: 'floodwait', statusUntil: 100 }, 200), true)
  assert.equal(isStatusExpired({ status: 'floodwait', statusUntil: 300 }, 200), false)
  assert.equal(isStatusExpired({ status: 'quarantine', statusUntil: 100 }, 200), true)
  assert.equal(isStatusExpired({ status: 'active', statusUntil: 100 }, 200), false) // не временный
  assert.equal(isStatusExpired({ status: 'floodwait', statusUntil: null }, 200), false) // бессрочный
})

test('nextStatusAfterExpiry: floodwait→prevStatus, quarantine→warming', () => {
  // floodwait истёк → возврат в prevStatus (active)
  assert.equal(nextStatusAfterExpiry({ status: 'floodwait', statusUntil: 100, prevStatus: 'active' }, 200), STATUS.ACTIVE)
  // floodwait истёк, но prevStatus нерабочий → active
  assert.equal(nextStatusAfterExpiry({ status: 'floodwait', statusUntil: 100, prevStatus: 'quarantine' }, 200), STATUS.ACTIVE)
  // quarantine истёк → на перепрогрев (не сразу в active), 🔒 §6
  assert.equal(nextStatusAfterExpiry({ status: 'quarantine', statusUntil: 100, prevStatus: 'active' }, 200), STATUS.WARMING)
  // ещё не истёк → null
  assert.equal(nextStatusAfterExpiry({ status: 'floodwait', statusUntil: 300, prevStatus: 'active' }, 200), null)
  // не временный статус → null
  assert.equal(nextStatusAfterExpiry({ status: 'active' }, 200), null)
})

// ── Спамблок ≠ полная нерабочесть: писать первым нельзя, отвечать можно ──

test('нейродиалоги берут аккаунт в спамблоке — они только отвечают', () => {
  // 21–22.07: 11 аккаунтов ушли в спамблок посреди живых переписок, и мы бросили
  // собеседников на полуслове. Ограничение Telegram — на первое сообщение незнакомому.
  assert.equal(canModuleUseAccount('neuro-dialogs', 'spamblock'), true)
})

test('модули, которые пишут первыми, аккаунт в спамблоке не берут', () => {
  for (const m of ['mailing', 'neuro-commenting', 'neuro-chatting', 'warming']) {
    assert.equal(canModuleUseAccount(m, 'spamblock'), false, `${m} не должен писать в спамблоке`)
  }
})

test('карантин и невалид закрыты даже для «только ответов»', () => {
  for (const s of ['quarantine', 'invalid', 'reauth']) {
    assert.equal(canModuleUseAccount('neuro-dialogs', s), false, s)
  }
})

test('MR-291: спамблок с истёкшим сроком возвращает аккаунт в работу', () => {
  /*
   * На проде 01.09 в спамблоке стояли 29 аккаунтов из 63 со сроком, кончившимся пять дней
   * назад. Механизм был построен целиком, кроме последнего шага: срок проставлялся
   * (`applySpamblockPolicy`), записи без срока долечивались (`backfillMissingStatusUntil`),
   * `DEFAULT_HOLD_HOURS.spamblock` был заведён — а `isStatusExpired` отвечало `false`,
   * потому что спамблок не входил в список временных статусов. Аккаунт не выходил НИКОГДА.
   */
  const истёк = { status: 'spamblock', statusUntil: Date.now() - 60_000, statusUntilSource: 'spambot' }
  assert.equal(isStatusExpired(истёк), true, 'спамблок обязан быть временным статусом')
  assert.equal(nextStatusAfterExpiry(истёк), 'active')

  // Срок ещё идёт — не трогаем.
  assert.equal(nextStatusAfterExpiry({ status: 'spamblock', statusUntil: Date.now() + 60_000, statusUntilSource: 'spambot' }), null)
  // Срока нет вовсе — тоже не трогаем: его проставит backfillMissingStatusUntil.
  assert.equal(nextStatusAfterExpiry({ status: 'spamblock' }), null)
})

test('MR-291: по ДЕФОЛТНОМУ сроку в работу не возвращаем — только по слову @SpamBot', () => {
  /*
   * Проверка на живых аккаунтах 02.09: шесть из шести всё ещё в блоке спустя ПЯТЬ дней
   * после «истёкшего» срока. Потому что срок был не от бота, а нашей догадкой — дефолтные
   * сутки, которые код подставляет, когда @SpamBot ничего не назвал.
   *
   * Вернуть по такой догадке значит пустить аккаунт работать под действующим ограничением,
   * а действия под спамблоком его продлевают. Это не спасение аккаунта, а закапывание.
   */
  const истёк = Date.now() - 60_000
  assert.equal(nextStatusAfterExpiry({ status: 'spamblock', statusUntil: истёк, statusUntilSource: 'default' }), null,
    'догадка о сроке возврата в работу не даёт')
  // Старые записи (источник не проставлен) — тоже догадка, пока не переспросим бота.
  assert.equal(nextStatusAfterExpiry({ status: 'spamblock', statusUntil: истёк }), null)
  // А слову бота верим.
  assert.equal(nextStatusAfterExpiry({ status: 'spamblock', statusUntil: истёк, statusUntilSource: 'spambot' }), 'active')
})

test('MR-291: спамблок возвращается в active, а карантин — в прогрев', () => {
  /*
   * Разница намеренная. Карантин — наше наказание за поведение, там перепрогрев уместен.
   * Спамблок ставит Telegram, и по истечении срока ограничение снял он сам.
   *
   * Плюс практика: `warming` в работу не пускает (NON_RUNNABLE), и возврат туда не решил бы
   * задачу, ради которой правка, — вернуть запертые аккаунты в строй.
   */
  const срок = Date.now() - 1000
  assert.equal(nextStatusAfterExpiry({ status: 'spamblock', statusUntil: срок, statusUntilSource: 'spambot' }), 'active')
  assert.equal(nextStatusAfterExpiry({ status: 'quarantine', statusUntil: срок }), 'warming')
  assert.equal(isRunnable('active'), true, 'иначе аккаунт останется вне работы')
})

test('MR-291: возврат из временных статусов идёт по расписанию, а не только на старте', async () => {
  /*
   * Второй половиной бага было место вызова: `reconcileExpiredStatuses` звался один раз при
   * запуске сервера. Между перезапусками истёкшие статусы не снимались вовсе — даже часовой
   * флудвейт ждал рестарта.
   */
  const fs = await import('node:fs')
  const index = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
  assert.match(index, /setInterval\(runStatus, \(cron\.statusTickMin \?\? 5\) \* 60 \* 1000\)/)

  // Интервал должен быть настраиваемым — как у остальных фоновых задач.
  const cron = fs.readFileSync(new URL('../cronSettings.js', import.meta.url), 'utf8')
  assert.match(cron, /key: 'statusTickMin'/)

  /*
   * И вызывать его можно только НИЖЕ объявления `SCHEDULERS_ON` и `cron`: выше они ещё в
   * мёртвой зоне, а весь блок обёрнут в try/catch — то есть падение было бы молчаливым, и
   * возврат статусов просто не работал бы. На этом я и попался, пока писал правку.
   */
  assert.ok(index.indexOf('const SCHEDULERS_ON') < index.indexOf('setInterval(runStatus'),
    'планировщик статусов стоит выше SCHEDULERS_ON — упадёт в catch молча')
  assert.ok(index.indexOf('let cron = {}') < index.indexOf('cron.statusTickMin'),
    'планировщик статусов стоит выше настроек крона')
})
