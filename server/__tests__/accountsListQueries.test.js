/**
 * MR-290: список аккаунтов не ходит в базу по разу на аккаунт.
 *
 * Отчего понадобилась проверка. Цикл в `tgListAccounts` не менялся много месяцев:
 * на каждом шаге он звал `getAccountMeta` и `loadSessionString`. Пока мета лежала одним
 * jsonb, а сессии — файлами на диске, это стоило копейки. Переезд в базу цену каждого
 * вызова изменил, а цикл остался прежним, и страница списка стала открываться в разы
 * дольше — при том что ни одной строки в самом цикле не тронули.
 *
 * Это и есть неприятная разновидность регресса: код, который замедлился, правкой не
 * затрагивался. Обычный тест такого не увидит — ответ верный, просто идёт медленно.
 *
 * ЧТО ЭТИ ПРОВЕРКИ ЛОВЯТ И ЧЕГО НЕ ЛОВЯТ.
 *
 *   Ловят: возвращение в цикл вызова, который читает хранилище целиком. Именно так
 *   это и появится снова — кто-то допишет в цикл `await getAccountMeta(id)`, потому что
 *   так короче, чем протаскивать карту.
 *
 *   НЕ ловят: медленный вызов, спрятанный за третьей функцией. Считать обращения к базе
 *   по-настоящему здесь нечем — клиент Supabase создаётся внутри модуля и в тест не
 *   подставляется. Поэтому сеть грубая, зато без ложных срабатываний.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { metaOf } from '../accountsMeta.js'
import { sessionPresence } from '../tgAuth.js'

const читать = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

/** Тело функции от её объявления до следующего объявления верхнего уровня. */
function телоФункции(код, объявление, следующее) {
  const от = код.indexOf(объявление)
  assert.notEqual(от, -1, 'не найдено объявление: ' + объявление)
  const до = код.indexOf(следующее, от)
  assert.notEqual(до, -1, 'не найден конец функции: ' + следующее)
  return код.slice(от, до)
}

test('в цикле по аккаунтам не осталось чтения меты по одному', () => {
  const функция = телоФункции(читать('../tgAccounts.js'),
    'export async function tgListAccounts', 'function dedupeAccounts')
  const цикл = функция.slice(функция.indexOf('for (const accountId of ids)'))
  assert.ok(!цикл.includes('getAccountMeta('),
    'getAccountMeta внутри цикла читает ВСЮ таблицу меты на каждый аккаунт — берите из карты через metaOf')
  assert.ok(!цикл.includes('loadAllMeta('),
    'loadAllMeta внутри цикла — то же самое чтение всей таблицы на каждый аккаунт')
})

test('карта меты и наличие сессий читаются ДО цикла', () => {
  const функция = телоФункции(читать('../tgAccounts.js'),
    'export async function tgListAccounts', 'function dedupeAccounts')
  const доЦикла = функция.slice(0, функция.indexOf('for (const accountId of ids)'))
  assert.ok(доЦикла.includes('loadAllMeta()'), 'мету читаем один раз на весь парк')
  assert.ok(доЦикла.includes('sessionPresence('), 'наличие сессий выясняем одним запросом на весь список')
})

test('строку сессии список читает только в режиме проверки', () => {
  // Списку сама строка не нужна — он отсеивает тех, у кого сессии нет. Чтение по
  // аккаунту оправдано только в ветке ?verify, где на каждый аккаунт и так идёт
  // подключение к Telegram.
  const функция = телоФункции(читать('../tgAccounts.js'),
    'export async function tgListAccounts', 'function dedupeAccounts')
  const цикл = функция.slice(функция.indexOf('for (const accountId of ids)'))
  const верифай = цикл.indexOf('if (verify) {')
  const чтение = цикл.indexOf('await loadSessionString(')
  assert.notEqual(верифай, -1, 'ветка verify на месте')
  assert.ok(чтение === -1 || чтение > верифай,
    'loadSessionString вне ветки verify — это запрос в базу на каждый аккаунт ради одного бита')
})

test('фоновая проверка парка тоже не читает мету по одному', () => {
  const тело = телоФункции(читать('../accountHealth.js'),
    'function dueAccounts', 'export async function accountHealthTick')
  assert.ok(!тело.includes('getAccountMeta('),
    'мета уже прочитана вызывающим — dueAccounts обязана брать её из карты')
})

test('чтение меты не тянет за собой каталог прокси', () => {
  /*
   * Первая редакция этой проверки требовала, чтобы подклейка строк шла через кэш
   * каталога. Это было лечение симптома: сам кэш появился только потому, что каталог
   * читали слишком часто. Причину убрали — вместе с подклейкой и кэшем.
   */
  const мета = читать('../accountsMeta.js')
  assert.ok(!/withProxyStrings\s*\(/.test(мета), 'мета отдаётся как лежит')
  const прокси = читать('../proxies.js')
  assert.ok(!/proxyCatalog\w*\s*\(/.test(прокси), 'копии каталога в памяти процесса больше нет')
  assert.ok(прокси.includes('export async function accountProxyUrl'),
    'строка подключения собирается по ссылке и в момент коннекта')
})

test('metaOf даёт то же, что getAccountMeta, но без похода в хранилище', () => {
  const карта = { acc_1: { status: 'pause', ownerId: 'usr_1' } }
  const m = metaOf(карта, 'acc_1')
  assert.equal(m.status, 'pause')
  assert.equal(m.ownerId, 'usr_1')
  assert.equal(m.service, false, 'умолчания подставлены, как в getAccountMeta')
})

test('metaOf на незнакомом аккаунте отдаёт умолчания, а не undefined', () => {
  // Иначе строка списка падала бы на первом же обращении к полю.
  const m = metaOf({}, 'acc_нет')
  assert.equal(m.status, 'active')
  assert.equal(m.role, 'Резерв')
  assert.equal(m.platform, false)
})

test('metaOf не портит исходную карту', () => {
  const карта = { acc_1: { status: 'active' } }
  const m = metaOf(карта, 'acc_1')
  m.status = 'pause'
  assert.equal(карта.acc_1.status, 'active', 'вернулась копия, а не сама запись')
})

test('пустой список аккаунтов в хранилище не ходит', async () => {
  const есть = await sessionPresence([])
  assert.equal(есть.size, 0)
})

test('sessionPresence отвечает множеством, а не массивом с дублями', async () => {
  // Один и тот же id, переданный дважды, не должен давать двух ответов.
  const есть = await sessionPresence(['acc_нет_такого', 'acc_нет_такого'])
  assert.ok(есть instanceof Set)
  assert.equal(есть.size, 0, 'несуществующая сессия — не «есть»')
})
