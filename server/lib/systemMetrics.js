/**
 * §10.9 (кол 29.07): нагрузка сервера «сейчас» — RPS и загрузка CPU/памяти, чтобы
 * владелец видел, тянет ли машина парк аккаунтов, и ловил всплески до падения.
 *
 * Всё считается в самом процессе, без внешних агентов:
 *  • RPS — кольцо из 60 посекундных корзин (память O(60), не растёт под нагрузкой);
 *  • CPU% — дельта process.cpuUsage() к реальному времени между двумя опросами;
 *  • память — RSS процесса против системной (важно на фоне лимита ≤3 ГБ/процесс).
 */
import os from 'node:os'

const WINDOW = 60 // секунд
const buckets = new Array(WINDOW).fill(0)
const bucketSec = new Array(WINDOW).fill(0) // какой абсолютной секунде принадлежит корзина

function touch(nowSec) {
  const i = nowSec % WINDOW
  if (bucketSec[i] !== nowSec) { buckets[i] = 0; bucketSec[i] = nowSec } // корзина протухла — переиспользуем
  return i
}

/** Express-middleware: считает каждый /api-запрос в текущую посекундную корзину. */
export function rpsMiddleware(_req, _res, next) {
  const nowSec = Math.floor(Date.now() / 1000)
  buckets[touch(nowSec)]++
  next()
}

// База для расчёта CPU%: дельта к предыдущему опросу.
let lastCpu = process.cpuUsage()
let lastHr = process.hrtime.bigint()

/** @returns {{ rps1s:number, rps1m:number, cpu:object, mem:object, uptimeSec:number }} */
export function systemMetrics() {
  const nowSec = Math.floor(Date.now() / 1000)

  // RPS: последняя секунда и средняя за минуту (только «свежие» корзины окна).
  let lastSec = 0
  let minuteTotal = 0
  for (let i = 0; i < WINDOW; i++) {
    if (nowSec - bucketSec[i] >= WINDOW) continue // корзина старше окна — не считаем
    minuteTotal += buckets[i]
    if (bucketSec[i] === nowSec - 1) lastSec = buckets[i] // завершённая секунда (текущая ещё копится)
  }

  // CPU%: (user+system за интервал) / (реальное время интервала × число ядер).
  const cpu = process.cpuUsage()
  const nowHr = process.hrtime.bigint()
  const elapsedUs = Number(nowHr - lastHr) / 1000 // нс → мкс
  const usedUs = cpu.user - lastCpu.user + (cpu.system - lastCpu.system)
  const cores = os.cpus().length || 1
  const procPct = elapsedUs > 0 ? Math.min(100, (usedUs / (elapsedUs * cores)) * 100) : 0
  lastCpu = cpu
  lastHr = nowHr

  const mem = process.memoryUsage()
  const totalMem = os.totalmem()
  const freeMem = os.freemem()

  const round1 = (n) => Math.round(n * 10) / 10
  const mb = (n) => Math.round(n / 1024 / 1024)

  return {
    rps1s: lastSec,
    rps1m: round1(minuteTotal / WINDOW),
    cpu: {
      procPct: round1(procPct),           // сколько ест наш процесс, % от всех ядер
      load1: round1(os.loadavg()[0] || 0), // системный load average за 1 мин (0 на Windows)
      cores,
    },
    mem: {
      rssMb: mb(mem.rss),                 // резидентная память процесса — следим за лимитом ≤3 ГБ
      heapUsedMb: mb(mem.heapUsed),
      systemUsedPct: round1(((totalMem - freeMem) / totalMem) * 100),
      systemTotalMb: mb(totalMem),
    },
    uptimeSec: Math.round(process.uptime()),
  }
}
