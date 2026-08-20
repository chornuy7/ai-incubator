/**
 * §5.1: прайс — сколько монет стоит одно действие каждого модуля.
 *
 * До этого монеты списывались ТОЛЬКО за токены ИИ, то есть платными были четыре
 * модуля из четырнадцати: комментинг, чаттинг, диалоги и рассылка. Автопостинг,
 * реакции, масслукинг, прогрев, AIR и все пять парсеров работали бесплатно —
 * при нулевом балансе тоже. А расходы там реальные: аккаунты, прокси, риск бана,
 * трафик. Заказчик это и заметил: «значит всё остальное они могут использовать
 * бесплатно?»
 *
 * Модель двухчастная и намеренно такая:
 *  - ДЕЙСТВИЕ — фиксированная цена из таблицы ниже (комментарий, реакция, просмотр,
 *    собранная страница парсера). Клиент может посчитать стоимость запуска заранее.
 *  - ТОКЕНЫ ИИ — сверх того, по факту расхода (`tokenLedger.js`). Генерация у разных
 *    модулей стоит по-разному, и зашивать её в фикс-цену значило бы либо переплату,
 *    либо работу в минус.
 *
 * ЦИФРЫ ВРЕМЕННЫЕ. Прайс утверждает заказчик (см. открытые вопросы в
 * docs/PROJECT-2026-07-22.md). Держим их одной таблицей, чтобы утверждённые
 * значения проставлялись в одном месте, а не искались по коду.
 */

/** Монет за одно успешное действие модуля. 0 — действие бесплатное. */
export const ACTION_PRICE = {
  // Боевые действия в Telegram: пишем/реагируем от имени живого аккаунта.
  mailing: 0.05,
  'neuro-commenting': 0.05,
  'neuro-chatting': 0.05,
  'neuro-dialogs': 0.05,
  autoposting: 0.03,
  'mass-react': 0.01,
  'mass-looking': 0.01,
  // Прогрев дешевле боевых: он не продвигает клиента, а готовит его же аккаунты.
  warming: 0.01,
  // AIR — аудит сетки: разовая тяжёлая проверка, считаем как действие.
  ggr: 0.02,
  // Сбор данных дешевле всего, но не бесплатен: это трафик и риск для аккаунта.
  parsing: 0.005,
  'parsing-groups': 0.005,
  'parsing-users': 0.005,
  'parsing-messages': 0.005,
  'parsing-comments': 0.005,
}

/**
 * Цена действия модуля. Неизвестный модуль — 0: новый модуль не должен молча
 * списывать деньги по чужой ставке, пока цену ему не проставили осознанно.
 * @param {string} moduleKey
 */
export function actionPrice(moduleKey) {
  return ACTION_PRICE[moduleKey] ?? 0
}

// MR-149 (созвон 19.08): расчёт «текст по максимуму символов» (MAX_TEXT_*, maxTextTokens,
// maxTextCoins, fullActionPrice) УДАЛЁН. Цена действия = базовая цена из БД, она уже включает
// текст, картинку, маржу и все расходы. Никаких надстроек за символы/токены поверх базы.

/**
 * §5.4: ПОДПИСКА НА МОДУЛЬ — сколько стоит держать модуль открытым, в месяц.
 *
 * Заказчик (23.07): «людина хоче нейрочатінг + мейлінг — вибирає собі модулі які
 * хоче, сума сумується і оплачується в кабінеті, доступ тільки до них». То есть
 * тариф не выбирают из трёх коробок — его СОБИРАЮТ: отметил модули, увидел сумму,
 * оплатил, получил ровно их.
 *
 * Отдельно от `ACTION_PRICE`: подписка — это право пользоваться модулем, а монеты
 * тратятся на сами действия внутри него. Смешивать нельзя, иначе клиент, который
 * ничего не запускал, платил бы ноль и держал модуль бесплатно.
 *
 * ЦИФРЫ ВРЕМЕННЫЕ — прайс утверждает заказчик. Ориентир из разговора: ~20 $ за модуль.
 */
export const MODULE_MONTH_PRICE = {
  mailing: 20,
  'neuro-commenting': 20,
  'neuro-chatting': 20,
  'neuro-dialogs': 25,
  autoposting: 15,
  'mass-react': 10,
  'mass-looking': 10,
  warming: 10,
  ggr: 15,
  parsing: 8,
  'parsing-groups': 8,
  'parsing-users': 8,
  'parsing-messages': 8,
  'parsing-comments': 8,
}

/** Валюта витрины. Меняется в одном месте вместе с ценами. */
export const CURRENCY = '$'

/**
 * MR-150 (созвон 12.08): сколько токенов ⚡ модуль выдаёт в МЕСЯЦ по подписке. Дефолт 100 на
 * модуль, настраивается в админке per-модуль. «Общее число токенов/мес» на витрине = сумма по
 * выбранным модулям (напр. 14 модулей × 100 = 1400). Отдельно от `gift` (разовый бонус при
 * первой покупке) и от `ACTION_PRICE` (плата за действие). Ноль — модуль токенов не выдаёт.
 */
export const MODULE_TOKENS_DEFAULT = 100

/**
 * Пакеты пополнения — СКОЛЬКО СТОИТ САМА МОНЕТА.
 *
 * Жили захардкоженными в шапке интерфейса, то есть курс монеты к деньгам был
 * третьим источником правды в вебе (после уже вынесенных отсюда тарифов лендинга).
 * Здесь — потому что это прайс: цена монеты определяет реальную выручку с каждого
 * действия, и расходиться с ней документу и витрине нельзя.
 *
 * `best` — что подсветить как выгодное: у крупных пакетов цена монеты ниже.
 */
export const COIN_PACKS = [
  { coins: 50, price: 4.99 },
  { coins: 200, price: 17.99, best: true },
  { coins: 500, price: 39.99 },
]

/** Цена одной монеты в пакете — чтобы выгода считалась, а не заявлялась. */
export function coinRate(pack) {
  const coins = Number(pack?.coins) || 0
  return coins ? Math.round((Number(pack.price) / coins) * 10000) / 10000 : 0
}

/**
 * Готовые сетапы — связки модулей под типовой сценарий, дешевле поштучной суммы.
 * `discount` — доля скидки от суммы входящих модулей (0.2 = −20%).
 */
export const SETUPS = [
  {
    id: 'setup-outreach',
    name: 'Аутрич',
    hint: 'Найти аудиторию, написать в личку и довести до цели',
    modules: ['parsing-users', 'parsing-groups', 'mailing', 'neuro-dialogs', 'neuro-chatting'],
    discount: 0.2,
  },
  {
    id: 'setup-engage',
    name: 'Вовлечение',
    hint: 'Присутствие в чужих каналах: комментарии, ответы, реакции',
    modules: ['parsing', 'parsing-comments', 'neuro-commenting', 'neuro-chatting', 'mass-react', 'mass-looking'],
    discount: 0.2,
  },
  {
    id: 'setup-all',
    name: 'Всё включено',
    hint: 'Все модули платформы без ограничений',
    modules: Object.keys(MODULE_MONTH_PRICE),
    discount: 0.35,
  },
]

/** Цена подписки на модуль в месяц. Неизвестный — 0. @param {string} moduleKey */
export function modulePrice(moduleKey, priceMap = MODULE_MONTH_PRICE) {
  return (priceMap && priceMap[moduleKey]) ?? MODULE_MONTH_PRICE[moduleKey] ?? 0
}

/**
 * Сумма за набор модулей с учётом скидки сетапа, если набор ему точно соответствует.
 * Считаем на сервере: витрина и то, что спишется, должны быть одним числом.
 * @param {string[]} moduleKeys @returns {{sum:number, full:number, setup:string|null, discount:number}}
 */
/**
 * Скидка за годовую оплату. ЕДИНЫЙ источник: и витрина, и запись о платеже берут
 * отсюда, иначе годовой план продаётся по одной цене, а в базу оплат пишется другая.
 */
export const ANNUAL_DISCOUNT = 0.2

/**
 * Сколько РЕАЛЬНО заряжается за период. Месяц — месячная сумма; год (12 мес) —
 * со скидкой ANNUAL_DISCOUNT. Именно это число уходит в журнал платежей, а не
 * месячная цена: раньше годовую подписку за ~$192 писали в базу оплат как $20.
 * @param {number} monthlySum @param {number} [months]
 */
export function periodCost(monthlySum, months = 1, annualDiscount = ANNUAL_DISCOUNT) {
  const m = Math.max(1, Number(months) || 1)
  // Скидка действует от 12 месяцев. Значение — эффективное (правится из админки),
  // а не константа: иначе поле «скидка за год» в админке было бы мёртвым.
  const discount = m >= 12 ? (Number(annualDiscount) || 0) : 0
  return Math.round(Number(monthlySum) * m * (1 - discount) * 100) / 100
}

/**
 * За что списать при смене подписки (§11.4, правка 18.08).
 *
 * Платим ТОЛЬКО за добавленное: пользователь, который убрал лишний модуль или просто
 * пересохранил набор, второй раз платить не должен. До этого покупка вообще не спрашивала
 * денег — с нулём на счету открывался любой набор.
 *
 * @param {string[]|'all'} had что уже оплачено
 * @param {string[]} wanted что хочет получить
 * @returns {{ added: string[], monthly: number }} добавленные модули и их цена за месяц
 */
export function addedCost(had, wanted, customBundles = [], priceMap = MODULE_MONTH_PRICE, setups = SETUPS) {
  if (had === 'all') return { added: [], monthly: 0 }
  const owned = new Set(Array.isArray(had) ? had : [])
  const added = [...new Set((Array.isArray(wanted) ? wanted : []).filter((k) => !owned.has(k)))]
  if (!added.length) return { added: [], monthly: 0 }
  return { added, monthly: subscriptionCost(added, customBundles, priceMap, {}, setups).sum }
}

// setups — готовые сетапы. По умолчанию код-константа SETUPS (дев/тесты); на проде
// сюда передают набор из БД (server/setups.js), чтобы витрина и списание считали одну
// скидку. Разъезд источников = клиенту показали одну цену, а списали другую.
export function subscriptionCost(moduleKeys = [], customBundles = [], priceMap = MODULE_MONTH_PRICE, giftMap = {}, setups = SETUPS) {
  const keys = [...new Set(moduleKeys.filter((k) => MODULE_MONTH_PRICE[k] !== undefined))]
  // §3 (MR-21): подарочные токены суммируются по выбранным модулям.
  const giftTokens = keys.reduce((acc, k) => acc + (Number(giftMap[k]) || 0), 0)
  const full = keys.reduce((acc, k) => acc + modulePrice(k, priceMap), 0)
  // Скидку даёт сетап, ВСЕ модули которого выбраны: иначе «почти сетап» получал бы
  // цену сетапа, и поштучная покупка была бы бессмысленной.
  let best = { setup: null, discount: 0, sum: full }
  for (const s of (setups || SETUPS)) {
    if (!s.modules.every((m) => keys.includes(m))) continue
    const sum = Math.round(full * (1 - s.discount) * 100) / 100
    if (sum < best.sum) best = { setup: s.id, discount: s.discount, sum }
  }
  // Наборы, собранные админом: цена задана ЯВНО и действует только на ТОЧНЫЙ состав.
  // Superset здесь не годится: «20 $ за парсер + комментинг» — это договорённость
  // про конкретный пакет, а не скидочный коэффициент на любую корзину с ними.
  // Если цена набора вдруг выше поштучной суммы — берём меньшую: клиент не должен
  // платить за «набор» больше, чем стоили бы те же модули по прайсу.
  const wanted = keys.slice().sort().join(',')
  for (const b of customBundles || []) {
    const mods = [...new Set((b?.modules || []).filter((k) => MODULE_MONTH_PRICE[k] !== undefined))]
    if (mods.sort().join(',') !== wanted || !wanted) continue
    const price = Math.round((Number(b.price) || 0) * 100) / 100
    if (price > 0 && price < best.sum) {
      best = { setup: b.id, discount: full ? Math.round((1 - price / full) * 1000) / 1000 : 0, sum: price }
    }
  }
  return { sum: best.sum, full, setup: best.setup, discount: best.discount, giftTokens }
}

