/**
 * §13 (MR-60/61): распределение процентов между параметрами.
 *
 * Правила из ТЗ:
 *  - при первоначальном заполнении — 100% поровну между параметрами;
 *  - при изменении НЕзакреплённого значения — остаток автоматически и поровну
 *    перераспределяется между ОСТАЛЬНЫМИ незакреплёнными;
 *  - сумма никогда не превышает 100% (закреплённые вычитаются из «бюджета»);
 *  - закреплённые (замок) значения не трогаем.
 *
 * Все значения — целые проценты; остаток от деления добавляем к первым индексам,
 * чтобы сумма ровно сходилась к бюджету.
 */

/** Разложить `total` поровну (целыми) по индексам `idxs`, отдавая остаток первым. */
function spread(total: number, idxs: number[], out: number[]): void {
  const n = idxs.length
  if (n === 0) return
  const t = Math.max(0, Math.round(total))
  const base = Math.floor(t / n)
  let rem = t - base * n
  for (const i of idxs) {
    out[i] = base + (rem > 0 ? 1 : 0)
    if (rem > 0) rem -= 1
  }
}

/** Первичное заполнение: 100% поровну между `count` параметрами. */
export function equalize(count: number): number[] {
  if (count <= 0) return []
  const out = new Array<number>(count).fill(0)
  spread(100, Array.from({ length: count }, (_, i) => i), out)
  return out
}

/** Выровнять поровну ТОЛЬКО незакреплённые, сохранив закреплённые (кнопка «поровну»). */
export function equalizeUnlocked(weights: number[], locked: boolean[] = []): number[] {
  const out = weights.map((w) => Math.max(0, Math.round(Number(w) || 0)))
  const lockedSum = out.reduce((s, w, i) => s + (locked[i] ? w : 0), 0)
  const idxs: number[] = []
  for (let i = 0; i < out.length; i++) if (!locked[i]) idxs.push(i)
  spread(Math.max(0, 100 - lockedSum), idxs, out)
  return out
}

/**
 * Изменение одного (незакреплённого) значения с авто-перераспределением остатка.
 * @param weights текущие проценты
 * @param changedIndex какой параметр меняем
 * @param rawValue новое (сырое) значение
 * @param locked маска замков (по индексам)
 */
export function redistribute(weights: number[], changedIndex: number, rawValue: number, locked: boolean[] = []): number[] {
  const n = weights.length
  const out = weights.map((w) => Math.max(0, Math.round(Number(w) || 0)))
  if (changedIndex < 0 || changedIndex >= n) return out
  const isLocked = (i: number) => !!locked[i]
  // Бюджет для незакреплённых = 100 минус сумма закреплённых.
  const lockedSum = out.reduce((s, w, i) => s + (isLocked(i) ? w : 0), 0)
  const room = Math.max(0, 100 - lockedSum)
  // Новое значение изменённого — в пределах бюджета (МR-60: не даём вылезти за 100%).
  const v = Math.min(room, Math.max(0, Math.round(Number(rawValue) || 0)))
  out[changedIndex] = v
  // Остальные незакреплённые (кроме изменённого) делят остаток поровну.
  const others: number[] = []
  for (let i = 0; i < n; i++) if (i !== changedIndex && !isLocked(i)) others.push(i)
  if (others.length) spread(Math.max(0, room - v), others, out)
  // Если делить не на кого — остаток просто не используется (сумма = lockedSum + v ≤ 100).
  return out
}

/** Сумма процентов (для индикатора). */
export function percentSum(weights: number[]): number {
  return weights.reduce((a, b) => a + (Number(b) || 0), 0)
}
