import { useEffect, useState } from 'react'
import { fetchAiSafety } from '@/api/featuresApi'

/**
 * Темп задачи — ровно тот же расчёт, что у воркера.
 *
 * Созвон 19.08: «разрыв по таймингам», ETA в карточке «считается по-херовому». Причина —
 * панель и карточка считали время по ОДНОМУ множителю (пресет темпа), а сервер применяет
 * ТРИ: `delayMultiplier` в server/lib/protection.js = LEVEL_MUL × PRESET_MUL × глобальный
 * множитель ИИ-безопасности. Совпадало это лишь потому, что в форме уровень защиты всегда
 * 1, а глобальные множители по умолчанию 1. Стоило админу выставить delayMultiplier = 2
 * или прийти задаче от MCP-агента с protectionLevel = 0 — и обещанное время расходилось
 * с фактическим в 1.8–2 раза.
 *
 * Константы обязаны совпадать с server/lib/protection.js — это сторожит
 * server/__tests__/paceContract.test.js.
 */
export const LEVEL_MUL = [1.8, 1, 0.75]
/** Custom (индекс 3) — задержки берутся как есть: PRESET_MUL[3] = 1. */
export const PRESET_MUL = [0.6, 1, 1.8, 1]

/** Множитель задержек: уровень защиты × пресет темпа × глобальный (ИИ-безопасность). */
export function delayMultiplier(level = 1, preset = 1, global = 1): number {
  return (LEVEL_MUL[level] ?? 1) * (PRESET_MUL[preset] ?? 1) * (global || 1)
}

// Глобальный множитель один на платформу и меняется редко — тянем его раз на вкладку,
// а не в каждой карточке задачи.
let cached: Promise<number> | null = null
function loadGlobalPace(): Promise<number> {
  if (!cached) {
    cached = fetchAiSafety()
      .then((s) => (s.delayMultiplier || 1) * (s.pacingMultiplier || 1))
      .catch(() => 1)
  }
  return cached
}

/** Глобальный множитель темпа. До ответа сервера — 1 (как дефолт ИИ-безопасности). */
export function useGlobalPace(): number {
  const [mul, setMul] = useState(1)
  useEffect(() => { let alive = true; void loadGlobalPace().then((m) => { if (alive) setMul(m) }); return () => { alive = false } }, [])
  return mul
}

/**
 * Сколько времени займёт задача — ОДИН расчёт на всю панель.
 *
 * Созвон 24.08: в блоке «Защита и тайминги» стояло «25 мин», в нижней панели запуска —
 * «13 мин» для одного и того же запуска. Считали в двух местах и по-разному: сверху
 * общее число действий принимали за «сколько сделает один аккаунт», снизу делили его
 * между аккаунтами. Теперь формула одна, и разойтись им негде.
 *
 * Как считает воркер (server/lib/targets.js): `maxActions` — это ОБЩАЯ цель задачи, а
 * каждому аккаунту достаётся его доля, `ceil(общая / аккаунты)`. Аккаунты работают
 * параллельно, поэтому время задачи — это время цепочки ОДНОГО аккаунта.
 *
 * @param actions общая цель задачи по действиям
 * @param accounts сколько аккаунтов выбрано (0 = считаем как для одного)
 * @param avgDelaySec средняя пауза между действиями, УЖЕ умноженная на множитель темпа
 */
export function taskSeconds(actions: number, accounts: number, avgDelaySec: number): number {
  const total = Math.max(0, Math.round(Number(actions) || 0))
  const acc = Math.max(1, Math.round(Number(accounts) || 0))
  const delay = Math.max(0, Number(avgDelaySec) || 0)
  if (!total || !delay) return 0
  return Math.ceil(total / acc) * delay
}

/** Сколько действий достанется одному аккаунту — та же доля, что считает воркер. */
export function perAccountShare(actions: number, accounts: number): number {
  const total = Math.max(0, Math.round(Number(actions) || 0))
  const acc = Math.max(1, Math.round(Number(accounts) || 0))
  return total ? Math.ceil(total / acc) : 0
}

/**
 * Сколько времени уйдёт на ВСТУПЛЕНИЯ в цели — у одного аккаунта.
 *
 * Замечание владельца 26.08: «задержка вступления ни на что не влияет — таймер меняется
 * только от задержки комментария». Так и было: время считалось по одним действиям, хотя
 * воркер реально спит эту паузу (server/lib/joinTarget.js — `Задержка перед вступлением`),
 * и при 281–600 с она весит больше самих комментариев.
 *
 * Считаем как воркер: пауза берётся ОДИН раз на пару «аккаунт + цель» и только если
 * аккаунт ещё не состоит в канале. Больше вступлений, чем у него действий, аккаунт не
 * сделает (цель на круге выбирается случайно), поэтому потолок — min(целей, доля действий).
 *
 * Уже вступившие аккаунты не платят эту паузу вовсе, а знать об этом заранее панель не
 * может — поэтому это ВЕРХНЯЯ оценка, «первый заход», и подписью так и говорим.
 *
 * @param targets сколько целей (каналов/групп) выбрано
 * @param actionsPerAccount доля действий одного аккаунта (perAccountShare)
 * @param avgJoinSec средняя пауза вступления, УЖЕ умноженная на множитель темпа
 */
export function joinSeconds(targets: number, actionsPerAccount: number, avgJoinSec: number): number {
  const t = Math.max(0, Math.round(Number(targets) || 0))
  const perAcc = Math.max(0, Math.round(Number(actionsPerAccount) || 0))
  const delay = Math.max(0, Number(avgJoinSec) || 0)
  if (!t || !perAcc || !delay) return 0
  return Math.min(t, perAcc) * delay
}
