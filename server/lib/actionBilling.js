/**
 * §5.1: списание монет за выполненные действия модуля.
 *
 * Живёт отдельно от воркеров по двум причинам. Первая — `workers.js` общий с чужой
 * дорожкой и правится с обеих сторон; биллинг там незаметно сломать проще всего.
 * Вторая — это деньги: правило «на нуле задача встаёт» должно быть покрыто тестом,
 * а не проверяться запуском реальных действий в Telegram.
 */
import { fullActionPrice } from '../pricing.js'

/**
 * Эффективные цены для расчёта единой цены действия (MR-149): админский курс токен→монета
 * и цена «за действие» из админки (eff.actionMap). `deps.coinsPer1k`/`deps.actionMap` —
 * подмена для тестов; иначе берём из priceStore.
 * @returns {Promise<{per1k:number, actionMap:Object|null}>}
 */
async function resolvePricing(deps = {}) {
  if (deps.coinsPer1k != null || deps.actionMap != null) {
    return { per1k: Number(deps.coinsPer1k) || 0, actionMap: deps.actionMap || null }
  }
  try {
    const { effectivePrices } = await import('../priceStore.js')
    const e = await effectivePrices()
    return { per1k: Number(e.coinsPer1kTokens) || 0, actionMap: e.actionMap || null }
  } catch { return { per1k: 0, actionMap: null } }
}
/** Единая цена действия по эффективным ценам (админ-база + макс-текст). */
function priceFor(moduleKey, { per1k, actionMap }) {
  const base = actionMap && actionMap[moduleKey] != null ? actionMap[moduleKey] : undefined
  return fullActionPrice(moduleKey, per1k, base)
}

/**
 * Списать за N выполненных действий и поставить задачу на паузу, если монеты кончились.
 *
 * Списываем ПОСЛЕ действия, а не до: предоплата за непроизошедшее действие
 * превращается в долг перед клиентом при первом же FloodWait. В минус баланс не
 * уходит, поэтому на нуле задачу тормозим сами — иначе правило «при нуле модули
 * стоят» действовало бы только на запуске, а начатая задача доработала бы даром.
 *
 * Именно ПАУЗА, а не стоп: прогресс, собранные результаты и позиция по целям
 * сохраняются, и после пополнения человек жмёт «Продолжить» вместо того, чтобы
 * начинать всё заново и платить за уже сделанное второй раз.
 *
 * Best-effort: сбой биллинга не роняет работающую задачу — действия в Telegram уже
 * совершены, и откатить их нельзя.
 *
 * @param {object} task @param {object} store @param {number} actions
 * @param {{changeCoins?:Function, getBalance?:Function}} [deps] подмена для тестов
 */
export async function chargeActions(task, store, actions = 1, deps = {}) {
  try {
    const n = Math.max(0, Number(actions) || 0)
    // MR-149: цена действия ЕДИНАЯ = фикс-действие + текст «по максимуму символов»,
    // по админскому курсу coinsPer1kTokens (токены сверх не списываются — tokenLedger журнал).
    const pricing = await resolvePricing(deps)
    // До тысячных: цена строки парсера — 0.005, и округление до сотых удваивало её.
    const cost = Math.round(priceFor(task?.moduleKey, pricing) * n * 1000) / 1000
    if (cost <= 0) return null
    const balance = deps.changeCoins && deps.getBalance ? deps : await import('../balance.js')
    const res = await balance.changeCoins(-cost, `${task.moduleKey}: ${n} действ.`, task.userId)
    // Считаем ФАКТИЧЕСКИ списанное, а не запрошенное: в минус кошелёк не уходит,
    // и при остатке 0.002 с ценой 0.005 спишется 0.002. Прибавляя полную цену, мы
    // предъявляли бы клиенту в счёте больше, чем с него взяли.
    const charged = Math.abs(Number(res?.applied) || 0) || cost
    // Сколько монет съела ЭТА задача — чтобы в Дашборде было видно цену запуска,
    // а не только общий баланс, из которого не понять, куда ушло.
    task.spentCoins = Math.round(((task.spentCoins || 0) + charged) * 1000) / 1000
    const { coins } = await balance.getBalance(task.userId)
    if (coins <= 0 && !task.pauseRequested && !task.stopRequested) {
      task.pauseRequested = true
      // Уровень info, а не error: кончившиеся деньги — не поломка модуля. С уровнем
      // error задача попадала и в «Задач с ошибками», и в «Встали из-за баланса»,
      // а в списке ошибок висела строка «Закончились монеты», хотя чинить нечего.
      await store?.appendLog?.(task, 'info', 'Закончились монеты — задача на паузе. Пополните баланс и нажмите «Продолжить»: прогресс сохранён.')
    }
    return { charged, left: coins }
  } catch {
    return null // не роняем задачу из-за биллинга
  }
}

/**
 * Парсеры считают прогресс по длине результата, а не через `bumpProgress`. Списываем
 * за НОВЫЕ собранные строки: без дельты каждый проход списывал бы за весь список
 * заново, и один и тот же сбор стоил бы тем дороже, чем дольше идёт задача.
 * @param {object} task @param {object} store
 * @param {{changeCoins?:Function, getBalance?:Function}} [deps]
 */
export async function chargeCollected(task, store, deps = {}) {
  const total = task?.results?.length || 0
  const billed = task?.billedResults || 0
  if (total <= billed) return null
  task.billedResults = total
  return chargeActions(task, store, total - billed, deps)
}

/**
 * Вернуть деньги за строки, которых в итоге не осталось.
 *
 * Парсер копит результаты по ходу, а фильтры (AND-пересечение ключей, чёрный список,
 * дедуп) применяются в конце и могут срезать список хоть до нуля. Живой прогон:
 * собрано 53 → списано за 53 → пересечение оставило 0, и человек заплатил за пустой
 * результат. Платим за то, что клиент реально получил.
 *
 * @param {object} task @param {object} store
 * @param {{changeCoins?:Function, getBalance?:Function}} [deps]
 */
export async function refundShrunk(task, store, deps = {}) {
  try {
    const total = task?.results?.length || 0
    const billed = task?.billedResults || 0
    if (billed <= total) return null
    const back = Math.round(priceFor(task?.moduleKey, await resolvePricing(deps)) * (billed - total) * 1000) / 1000
    task.billedResults = total
    if (back <= 0) return null
    const balance = deps.changeCoins && deps.getBalance ? deps : await import('../balance.js')
    await balance.changeCoins(back, `${task.moduleKey}: возврат за ${billed - total} отфильтрованных`, task.userId)
    task.spentCoins = Math.max(0, Math.round(((task.spentCoins || 0) - back) * 1000) / 1000)
    await store?.appendLog?.(task, 'info', `Возврат ${back} монет: фильтры убрали ${billed - total} из ${billed} собранных строк.`)
    return { refunded: back }
  } catch {
    return null
  }
}
