import { cn } from '@/shared/lib/utils'

/**
 * Выбор уровня защиты — общий для всех модулей.
 *
 * До 25.08 этого выбора не было НИГДЕ: `protectionLevel` был зашит в код (в модулях 1,
 * в мейлинге 0) и менялся только применением сохранённого шаблона. При этом сервер его
 * честно читает — от уровня зависят и потолок вероятности (`effectiveProbability`), и
 * множитель задержек (`LEVEL_MUL`), и период работы. Оператор видел подсказку «выберите
 * Агрессивный», жал одноимённый пресет ЗАДЕРЖЕК и не получал ничего (жалоба владельца).
 *
 * Поэтому названия здесь НАМЕРЕННО не совпадают с пресетами темпа и содержат числа: два
 * ряда одинаковых слов с разным смыслом в одной форме и породили ту путаницу.
 *
 * Отдельного переключателя «Защита ИИ» не делаем: серверный флаг `aiProtection` включает
 * ровно одно — тот же потолок вероятности. Второй рычаг на тот же эффект — это ещё одна
 * такая же ловушка.
 */
export const PROTECTION_CAP = [25, 45, 100]

export const PROTECTION_LEVELS = [
  { name: 'Осторожный', cap: 'до 25%', hint: 'Потолок вероятности 25%, задержки ×1.8 — для новых и дорогих аккаунтов' },
  { name: 'Сбалансированный', cap: 'до 45%', hint: 'Потолок вероятности 45%, базовые задержки — повседневный режим' },
  { name: 'Без потолка', cap: '100%', hint: 'Вероятность работает как задана, задержки ×0.75 — быстрее, но выше риск FloodWait и ограничений' },
]

export function ProtectionLevelPicker({ value, onChange, note }: { value: number; onChange: (n: number) => void; note?: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">Уровень защиты</div>
      <div className="flex flex-wrap gap-1.5">
        {PROTECTION_LEVELS.map((lv, i) => (
          <button
            key={lv.name}
            type="button"
            onClick={() => onChange(i)}
            title={lv.hint}
            className={cn('rounded-lg border px-2.5 py-1.5 text-[11px] font-semibold transition-colors',
              value === i
                ? 'border-spark-500/50 bg-spark-500/12 text-spark-200'
                : 'border-line text-muted hover:border-spark-500/30 hover:text-fg')}
          >
            {lv.name} <span className="font-normal text-faint">· {lv.cap}</span>
          </button>
        ))}
      </div>
      {note && <p className="mt-1.5 text-[11px] text-white/45">{note}</p>}
    </div>
  )
}
