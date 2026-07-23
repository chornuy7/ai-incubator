/**
 * §5.1: списание монет за выполненные действия модуля.
 *
 * Живёт отдельно от воркеров по двум причинам. Первая — `workers.js` общий с чужой
 * дорожкой и правится с обеих сторон; биллинг там незаметно сломать проще всего.
 * Вторая — это деньги: правило «на нуле задача встаёт» должно быть покрыто тестом,
 * а не проверяться запуском реальных действий в Telegram.
 */
import { actionPrice } from '../pricing.js'

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
    // До тысячных: цена строки парсера — 0.005, и округление до сотых удваивало её.
    const cost = Math.round(actionPrice(task?.moduleKey) * n * 1000) / 1000
    if (cost <= 0) return null
    const balance = deps.changeCoins && deps.getBalance ? deps : await import('../balance.js')
    await balance.changeCoins(-cost, `${task.moduleKey}: ${n} действ.`, task.userId)
    // Сколько монет съела ЭТА задача — чтобы в Дашборде было видно цену запуска,
    // а не только общий баланс, из которого не понять, куда ушло.
    task.spentCoins = Math.round(((task.spentCoins || 0) + cost) * 1000) / 1000
    const { coins } = await balance.getBalance(task.userId)
    if (coins <= 0 && !task.pauseRequested && !task.stopRequested) {
      task.pauseRequested = true
      await store?.appendLog?.(task, 'error', 'Закончились монеты — задача на паузе. Пополните баланс и нажмите «Продолжить»: прогресс сохранён.')
    }
    return { charged: cost, left: coins }
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
    const back = Math.round(actionPrice(task?.moduleKey) * (billed - total) * 1000) / 1000
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
