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
