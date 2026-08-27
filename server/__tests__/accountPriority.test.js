/**
 * Приоритет на общий аккаунт: первая запущенная задача работает, вторая ждёт
 * (решение владельца 27.08).
 *
 * Прогон 27.08: нейрокомментинг и массовые реакции полчаса перетягивали один профиль и
 * сделали одно действие на двоих. Слот доставался тому, кто первым СПРОСИЛ после
 * освобождения, а оба модуля опрашивают аккаунт каждые 15 секунд вразнобой — побеждал
 * случайный.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { beginAccountWork, endAccountWork, releaseTaskBusy, reconcileBusy } from '../lib/accountBusy.js'
import { markTaskLive, markTaskDone } from '../lib/accountLocks.js'

/** Уникальный аккаунт на тест: слоты живут в памяти модуля и общие для всех тестов. */
let n = 0
const account = () => `acc_prio_${n += 1}`

beforeEach(() => { reconcileBusy(Date.now()) })

/** Запустить две задачи с гарантированной разницей во времени старта. */
function twoTasks(prefix) {
  const first = `${prefix}-первая`
  const second = `${prefix}-вторая`
  markTaskLive(first)
  // Старт различаем по времени: Date.now() внутри markTaskLive может совпасть на быстрой
  // машине, а приоритет считается именно по нему.
  const wait = Date.now() + 5
  while (Date.now() < wait) { /* ждём смены миллисекунды */ }
  markTaskLive(second)
  return { first, second }
}

test('пока первая задача жива, вторая не забирает освободившийся аккаунт', () => {
  const acc = account()
  const { first, second } = twoTasks('t1')

  assert.equal(beginAccountWork(acc, 'mass-react', first).ok, true)

  const refused = beginAccountWork(acc, 'mass-react', second)
  assert.equal(refused.ok, false)
  assert.match(refused.reason, /занят действием/)

  endAccountWork(acc, first) // первая закончила ОДНО действие, но задача продолжается

  const stillWaiting = beginAccountWork(acc, 'mass-react', second)
  assert.equal(stillWaiting.ok, false, 'младшая задача не должна перехватывать аккаунт')
  assert.match(stillWaiting.reason, /запущена раньше/)

  assert.equal(beginAccountWork(acc, 'mass-react', first).ok, true, 'старшая берёт снова')

  markTaskDone(first)
  markTaskDone(second)
})

test('когда первая задача завершилась, аккаунт достаётся второй', () => {
  const acc = account()
  const { first, second } = twoTasks('t2')

  beginAccountWork(acc, 'mass-react', first)
  beginAccountWork(acc, 'mass-react', second) // встала в спор
  endAccountWork(acc, first)
  releaseTaskBusy(first)
  markTaskDone(first)

  assert.equal(beginAccountWork(acc, 'mass-react', second).ok, true)
  markTaskDone(second)
})

test('очередь не мешает задаче работать своим аккаунтом', () => {
  const acc = account()
  const { first, second } = twoTasks('t3')

  // Вторая спорит за ДРУГОЙ аккаунт — на этот её претензия не распространяется.
  beginAccountWork(account(), 'mass-react', second)

  assert.equal(beginAccountWork(acc, 'neuro-commenting', first).ok, true)
  endAccountWork(acc, first)
  assert.equal(beginAccountWork(acc, 'neuro-commenting', first).ok, true, 'своя задача берёт свободный аккаунт без задержек')

  markTaskDone(first)
  markTaskDone(second)
})
