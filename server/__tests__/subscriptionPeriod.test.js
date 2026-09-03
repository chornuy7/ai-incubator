/**
 * §5.1: срок подписки (expiresAt). Покупка на N месяцев ставит дату окончания;
 * без периода — бессрочно (null, демо). Личная подписка перекрывает пространство
 * и по набору, и по сроку.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'

const D = 86_400_000

process.env.BALANCE_FILE = path.join(os.tmpdir(), `subper-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
await fs.rm(process.env.BALANCE_FILE, { force: true })
const B = await import('../balance.js')

test('покупка на месяц → срок около 30 дней вперёд', async () => {
  await B.setUserModules(['mailing'], 'u1', { months: 1 })
  const b = await B.getBalance('u1')
  assert.deepEqual(b.modules, ['mailing'])
  assert.ok(b.expiresAt > Date.now(), 'срок в будущем')
  const days = (b.expiresAt - Date.now()) / D
  assert.ok(days > 25 && days < 35, `около 30 дней, получили ${days}`)
})

test('без периода → бессрочно (null)', async () => {
  await B.setUserModules(['ggr'], 'u2')
  assert.equal((await B.getBalance('u2')).expiresAt, null)
})

test('годовая подписка → около 360 дней', async () => {
  // Решение 18.08: набор пространства больше не наследуется теми, у кого нет своей
  // записи (иначе он раздавался каждой новой регистрации). Срок считаем на личной.
  await B.setUserModules('all', 'u3', { months: 12 })
  const b = await B.getBalance('u3')
  assert.equal(b.modules, 'all')
  const days = (b.expiresAt - Date.now()) / D
  assert.ok(days > 340 && days < 375, `около 360 дней, получили ${days}`)
})

test('личная подписка перекрывает пространство и по сроку', async () => {
  // u1 купил личный набор на месяц; пространство — на год. У u1 действует личный срок.
  const b = await B.getBalance('u1')
  const days = (b.expiresAt - Date.now()) / D
  assert.ok(days < 35, `личный месячный срок, а не годовой пространства (${days})`)
})

/**
 * Баг 19.08 (§2): СРОК ХРАНИЛСЯ, НО НИЧЕГО НЕ ЗАКРЫВАЛ.
 *
 * `modulesAllow` смотрела только на состав набора, поэтому оплаченный на месяц модуль
 * работал вечно: дата окончания писалась в balance.json и в `subscriptions.expires_at`
 * и не читалась ни одним гейтом. Проверяем ровно то поведение, которого не было.
 */
/** Отмотать срок подписки в прошлое: купить «на минус месяц» через API нельзя. */
async function expireSub(userId, daysAgo) {
  const raw = JSON.parse(await fs.readFile(process.env.BALANCE_FILE, 'utf8'))
  raw[userId].expiresAt = Date.now() - daysAgo * D - 1000
  await fs.writeFile(process.env.BALANCE_FILE, JSON.stringify(raw), 'utf8')
}

test('истёкшая подписка закрывает доступ, хотя модуль остался в наборе', async () => {
  await B.setUserModules(['mailing'], 'u_exp', { months: 1 })
  await expireSub('u_exp', 3)

  const b = await B.getBalance('u_exp')
  assert.deepEqual(b.modules, ['mailing'], 'состав набора не трогаем — истёк срок, а не покупка')
  assert.equal(B.subscriptionExpired(b.expiresAt), true)
  assert.equal(B.daysSinceExpiry(b.expiresAt), 3, 'сколько дней назад истекла — для текста отказа')
  assert.equal(B.modulesAllow(b.modules, 'mailing', b.expiresAt), false, 'просрочка не пускает')
  // Без срока вопрос другой — «куплен ли модуль вообще»; так считает витрина и докупка.
  assert.equal(B.modulesAllow(b.modules, 'mailing'), true)
  assert.equal(B.modulesAllow(b.modules, 'warming', b.expiresAt), false, 'непокупленный закрыт и так')
})

test('срок ещё не наступил — доступ открыт', async () => {
  await B.setUserModules(['warming'], 'u_live', { months: 1 })
  const b = await B.getBalance('u_live')
  assert.equal(B.subscriptionExpired(b.expiresAt), false)
  assert.equal(B.modulesAllow(b.modules, 'warming', b.expiresAt), true)
})

test('бессрочная подписка (expiresAt=null) не закрывается никогда', async () => {
  await B.setUserModules(['ggr'], 'u_forever')
  const b = await B.getBalance('u_forever')
  assert.equal(b.expiresAt, null)
  assert.equal(B.subscriptionExpired(null), false)
  assert.equal(B.subscriptionExpired(undefined), false)
  assert.equal(B.subscriptionExpired(0), false)
  assert.equal(B.modulesAllow(b.modules, 'ggr', b.expiresAt), true)
})

test('дефолтный воркспейс без срока остаётся открытым (фон воркеров не ломаем)', async () => {
  // Списания воркеров идут под кошельком `__default`, у которого своей подписки нет:
  // набор наследуется от пространства, а срок — null. Закрыться он не должен.
  await B.setModules('all', undefined, {})
  const b = await B.getBalance()
  assert.equal(b.modules, 'all')
  assert.equal(b.expiresAt, null, 'бессрочно — иначе фон однажды встал бы целиком')
  assert.equal(B.modulesAllow(b.modules, 'warming', b.expiresAt), true)
})
