/**
 * MR-297: снятие спамблока после живого прогона на проде 02.09.
 *
 * Три вещи, которые прогон показал сразу:
 *   · задача не переживала перезапуск сервиса — предстартовая проверка бракует «нерабочие»
 *     статусы, а спамблок как раз такой, и для ЭТОГО модуля он условие работы, а не помеха;
 *   · журнал забит очевидным «Аккаунт пропущен: в спамблоке» по каждому аккаунту;
 *   · факт подачи жалобы нигде не сохранялся — жил только в журнале задачи.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const каталог = fs.mkdtempSync(path.join(os.tmpdir(), 'mr297-'))
process.env.DATA_DIR = каталог
process.env.ACCOUNTS_META_FILE = path.join(каталог, 'accounts-meta.json')

const { preflightAccounts } = await import('../lib/preflight.js')
const { setAccountMeta } = await import('../accountsMeta.js')

test.after(() => { try { fs.rmSync(каталог, { recursive: true, force: true }) } catch { /* нечего убирать */ } })

test('спамблок НЕ помеха для модуля снятия спамблока', async () => {
  /*
   * «Запуск отменён: ни один аккаунт не готов. Wyatt Lamb — в спамблоке; Настя Barry — в
   * спамблоке…» — вот так задача умирала от любого перезапуска сервиса. Первый запуск ещё
   * проходил, возобновление — нет.
   */
  await setAccountMeta('acc_sb', { name: 'Спамблокнутый', status: 'spamblock', proxyId: 'px_1' })

  const обычный = await preflightAccounts(['acc_sb'], { moduleKey: 'neuro-commenting' })
  assert.equal(обычный.ready.length, 0, 'обычному модулю спамблокнутый аккаунт не годится')
  assert.match(обычный.problems[0].reason, /спамблок/)

  const снятие = await preflightAccounts(['acc_sb'], { moduleKey: 'spam-unblock' })
  assert.ok(!снятие.problems.some((p) => /спамблок/.test(p.reason)),
    'для снятия спамблока сам спамблок помехой быть не может — иначе работать не с кем')
})

test('остальные помехи остаются помехами и для него', async () => {
  /*
   * Снять статус-гейт не значит снять проверку целиком: без сессии подключиться нельзя
   * никаким модулем, и молчать об этом — обречь оператора на «ошибка подключения» без причины.
   */
  await setAccountMeta('acc_nosess', { name: 'Без сессии', status: 'spamblock' })
  const r = await preflightAccounts(['acc_nosess'], { moduleKey: 'spam-unblock' })
  assert.ok(r.problems.some((p) => /сесси|прокси/.test(p.reason)), 'нет сессии или прокси — это настоящая помеха')
})

test('подача жалобы запоминается НА АККАУНТЕ, а не только в журнале', () => {
  /*
   * Закрыли задачу — и не сказать, у кого обращение висит. При трёх десятках спамблоков это
   * подача по второму разу вслепую, а частые обращения антиспам считает поведением.
   */
  const модуль = fs.readFileSync(new URL('../spamUnblock.js', import.meta.url), 'utf8')
  assert.match(модуль, /if \(res\.appealed\)/, 'помним по факту нажатий, а не только по успеху')
  assert.match(модуль, /appealAt: Date\.now\(\)/)
  assert.match(модуль, /appealState:/)
  // Сняли — обращение закрыто, висеть ему больше незачем.
  assert.match(модуль, /appealState: 'cleared'/)

  const мета = fs.readFileSync(new URL('../accountsMeta.js', import.meta.url), 'utf8')
  assert.match(мета, /\['appealAt',\s+'appeal_at',\s+'ts'\]/)
  assert.match(мета, /\['appealState',\s+'appeal_state',\s+'text'\]/)

  const м = fs.readFileSync(new URL('../../supabase/migrations/2026-09-02-mr297-appeal.sql', import.meta.url), 'utf8')
  assert.match(м, /add column if not exists appeal_at/)
  assert.match(м, /add column if not exists appeal_state/)
  // И колонки обязаны попасть в представление — иначе списку их не видно.
  assert.match(м, /p\.appeal_state/)
  // Вместе с колонкой MR-292: представление пересобирается целиком, и потерять её нельзя.
  assert.match(м, /p\.status_until_source/)
})

test('состояние жалобы доезжает до витрины', () => {
  const список = fs.readFileSync(new URL('../accountsList.js', import.meta.url), 'utf8')
  assert.match(список, /appeal: r\.appeal_state \?/)
  const апи = fs.readFileSync(new URL('../../src/api/accountsApi.ts', import.meta.url), 'utf8')
  assert.match(апи, /appeal: a\.appeal \?/)
  const карточка = fs.readFileSync(new URL('../../src/features/account-manager/AccountManagementModal.tsx', import.meta.url), 'utf8')
  assert.match(карточка, /Жалоба подана — ждём модерацию/)
  // Снятую жалобу не показываем: она больше ни о чём не говорит.
  assert.match(карточка, /account\.appeal\.state !== 'cleared'/)
})
