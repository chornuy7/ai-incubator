import { useCallback, useRef } from 'react'
import type { ModuleTaskSettings } from '@/api/modulesApi'

/**
 * Шаблон обязан доносить и то, чему в интерфейсе нет ручки.
 *
 * Созвон 19.08: «сохранил шаблон — настройки слетают». Половина случаев — не забытый
 * `setX`, а устройство: `buildSettings` собирает настройки ЗАНОВО из состояния формы,
 * поэтому всё, что формой не показывается, при запуске исчезает. А показывается не всё:
 * задачу может поставить MCP-агент (`server/mcp/descriptors`) с параметрами, для которых
 * контролов в модуле нет — `delayPreset` у парсеров, `threads`/`typeWeights` у
 * нейродиалогов. Сервер их читает, форма — нет.
 *
 * Поэтому применённый шаблон запоминаем целиком и кладём ПОД собранные настройки:
 * что форма задаёт — перекроет, остальное доедет до сервера нетронутым.
 */
type Carried = Partial<ModuleTaskSettings>

export function usePresetCarry() {
  const applied = useRef<Carried>({})
  /** Запомнить шаблон в момент применения — вызывать в начале applyPreset. */
  const remember = useCallback((s: Carried) => { applied.current = { ...s } }, [])
  /** Подложка для buildSettings: `({ ...carry(), ...поля формы })`. */
  const carry = useCallback((): Carried => applied.current, [])
  return { carry, remember }
}
