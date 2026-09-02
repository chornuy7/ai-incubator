/**
 * MR-292: ЧТО именно с аккаунтом — вид ограничения, а не одно слово «Спамблок».
 *
 * Владелец 01.09: «нам нужно определять, что с аккаунтом, и давать чёткое понятие».
 * До этого все ограничения выглядели одинаково, хотя судьба аккаунта у них разная:
 * временное отпустит само, вечное снимается только апелляцией, бан платформы не
 * снимается вовсе. Оператор ждал снятия у аккаунта, которого уже нет.
 *
 * Главное, что здесь сторожится, — НЕ ВРАТЬ ПРО СРОК. Срок считается настоящим, только
 * если его назвал сам Telegram; наш код при неизвестном сроке подставляет сутки, и
 * проверка 02.09 показала шесть аккаунтов из шести всё ещё в блоке спустя пять дней
 * после такого «срока».
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { limitKind, geoRisk, LIMIT } from '../lib/limitKind.js'
import { computeAccountRisk } from '../lib/accountRisk.js'
import { rowToAccount } from '../accountsList.js'

const ЧАС = 60 * 60 * 1000

test('бан платформы и протухшая сессия — разные вещи, и это видно', () => {
  /*
   * Раньше и то и другое читалось как «Невалидный». Разница принципиальная: во втором
   * случае аккаунт цел и возвращается входом по номеру, в первом — не возвращается никак,
   * и попытки его чинить это потерянное время.
   */
  assert.equal(limitKind({ status: 'invalid' }).kind, LIMIT.BANNED)
  assert.equal(limitKind({ status: 'reauth' }).kind, LIMIT.REAUTH)
  assert.match(limitKind({ status: 'reauth' }).what, /войти повторно/i)
})

test('спамблок со сроком ОТ БОТА — временный, срок отдаём', () => {
  const до = Date.now() + 5 * ЧАС
  const r = limitKind({ status: 'spamblock', statusUntil: до, statusUntilSource: 'spambot' })
  assert.equal(r.kind, LIMIT.TEMPORARY)
  assert.equal(r.until, до)
})

test('спамблок с НАШИМ сроком — без срока, дату не показываем', () => {
  /*
   * Ровно та ошибка, из-за которой едва не вернули в работу 29 аккаунтов под действующим
   * ограничением: срок в базе есть, но подставлен нашим кодом. Действия под спамблоком
   * его продлевают — то есть «вернуть по сроку» означало бы закопать аккаунт глубже.
   */
  const r = limitKind({ status: 'spamblock', statusUntil: Date.now() + 5 * ЧАС, statusUntilSource: 'default' })
  assert.equal(r.kind, LIMIT.PERMANENT)
  assert.equal(r.until, null, 'выдуманный срок наружу не отдаём вовсе')

  // Признака источника нет вообще (старые записи) — тоже не срок.
  assert.equal(limitKind({ status: 'spamblock', statusUntil: Date.now() + ЧАС }).kind, LIMIT.PERMANENT)
})

test('срок от бота ИСТЁК, а блок остался — это уже без срока', () => {
  const r = limitKind({ status: 'spamblock', statusUntil: Date.now() - ЧАС, statusUntilSource: 'spambot' })
  assert.equal(r.kind, LIMIT.PERMANENT)
})

test('флудвейт — временный, и срок у него всегда настоящий', () => {
  // FLOOD_WAIT_X приходит от Telegram числом секунд: гадать не приходится.
  const до = Date.now() + 2 * ЧАС
  const r = limitKind({ status: 'floodwait', statusUntil: до })
  assert.equal(r.kind, LIMIT.TEMPORARY)
  assert.equal(r.until, до)
  assert.match(r.label, /Флуд/i, 'флудвейт — не спамблок, и называть его так нельзя')
})

test('пауза и карантин — НАШИ решения, а не ограничения Telegram', () => {
  for (const s of ['active', 'pause', 'quarantine', 'warming']) {
    assert.equal(limitKind({ status: s }).kind, LIMIT.NONE, s)
  }
  assert.match(limitKind({ status: 'pause' }).label, /Telegram/,
    'подпись обязана уточнять, что речь про ограничения платформы: аккаунт на паузе не «без ограничений»')
})

test('гео — оценка, а не вердикт: без обеих стран молчим', () => {
  assert.equal(geoRisk({ country: 'ua' }, null), null)
  assert.equal(geoRisk({}, { country: 'us' }), null)
  assert.equal(geoRisk({ country: 'ua' }, { country: 'ua' })?.mismatch, false)
  const р = geoRisk({ country: 'ua' }, { country: 'us' })
  assert.equal(р.mismatch, true)
  assert.match(р.text, /UA/)
  assert.match(р.text, /US/)
})

test('гео-расхождение становится фактором риска отдельной осью', () => {
  /*
   * Отдельно от прокси намеренно: прокси может быть живым и быстрым и при этом быть не
   * из той страны, где регистрировался профиль.
   */
  const r = computeAccountRisk({ status: 'active', proxyOk: true, noProxy: false, geo: { mismatch: true, text: 'Гео расходится: аккаунт UA, прокси US.' } })
  assert.equal(r.level, 'medium')
  assert.equal(r.factors.filter((f) => f.kind === 'geo').length, 1)
  assert.equal(r.proxyIssue, false, 'прокси тут ни при чём — он рабочий')
})

test('вид ограничения попадает в текст риска вместо общей фразы', () => {
  const огр = limitKind({ status: 'spamblock', statusUntilSource: 'default' })
  const r = computeAccountRisk({ status: 'spamblock', proxyOk: true, limit: огр })
  const текст = r.factors.find((f) => f.kind === 'status').text
  assert.match(текст, /без срока/i)
  // И запасной путь: вид не посчитан — остаётся прежняя общая формулировка.
  assert.match(computeAccountRisk({ status: 'spamblock', proxyOk: true }).factors[0].text, /Спамблок/)
})

test('строка списка несёт вид ограничения и гео — один расчёт на список и карточку', () => {
  /*
   * Считать это в интерфейсе нельзя: список и карточка уже расходились так по прокси —
   * одна формула на витрине, другая во вкладке, и они противоречили друг другу на экране.
   */
  const a = rowToAccount({
    id: 'acc1', phone: '380501112233', country: 'ua', status: 'spamblock',
    status_until: new Date(Date.now() + 3 * ЧАС).toISOString(), status_until_source: 'spambot',
    proxy_id: 'px1', proxy_status: 'ok', proxy_country: 'us',
  })
  assert.equal(a.limit.kind, LIMIT.TEMPORARY)
  assert.ok(a.limit.until > Date.now())
  assert.equal(a.geo.mismatch, true)
  assert.ok(a.risk.factors.some((f) => f.kind === 'geo'), 'гео обязано доехать до зоны риска')

  // Без прокси сравнивать нечего — молчим, а не додумываем.
  const б = rowToAccount({ id: 'acc2', phone: '380501112233', country: 'ua', status: 'active' })
  assert.equal(б.limit.kind, LIMIT.NONE)
  assert.equal(б.geo, null)
})

test('источник срока доезжает до базы: колонка и представление', () => {
  /*
   * Признак лежал только в jsonb `data`, а список читает представление `account_list` —
   * то есть до витрины не доезжал, и КАЖДЫЙ спамблок выглядел бы «без срока» даже там,
   * где бот срок назвал.
   */
  const мета = fs.readFileSync(new URL('../accountsMeta.js', import.meta.url), 'utf8')
  assert.match(мета, /\['statusUntilSource',\s*'status_until_source',\s*'text'\]/)

  const м = fs.readFileSync(new URL('../../supabase/migrations/2026-09-02-mr292-limit-source.sql', import.meta.url), 'utf8')
  assert.match(м, /add column if not exists status_until_source/)
  assert.match(м, /p\.status_until_source/, 'колонка обязана попасть в представление, иначе списку её не видно')
  // Уже накопленное в jsonb переносим, иначе признак потеряется при выкате.
  assert.match(м, /data->>'statusUntilSource'/)
})
