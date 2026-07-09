import { fetchModuleTasks, fetchModuleTask } from './modulesApi'
import { fetchTgstatImports, fetchTgstatChats } from './tgstatApi'

export interface HistoryItem {
  id: string
  source: 'module' | 'tgstat'
  moduleKey: string
  moduleLabel: string
  status: 'done' | 'running' | 'error'
  date: number
  keywords: string[]
  found: number
}

const MODULE_LABEL: Record<string, string> = {
  parsing: 'Каналы',
  'parsing-groups': 'Группы',
  'parsing-users': 'Пользователи',
  'parsing-messages': 'Сообщения',
  'parsing-comments': 'Комментарии',
  tgstat: 'TGStat',
}
const PARSER_KEYS = ['parsing', 'parsing-groups', 'parsing-users', 'parsing-messages', 'parsing-comments']

function mapModuleStatus(s: string): HistoryItem['status'] {
  if (s === 'done' || s === 'stopped') return 'done'
  if (s === 'error') return 'error'
  return 'running'
}
function mapTgstatStatus(s: string): HistoryItem['status'] {
  if (s === 'completed' || s === 'cancelled') return 'done'
  if (s === 'failed') return 'error'
  return 'running'
}

/** Агрегированная история всех парсеров + TGStat-импортов. */
export async function fetchParsingHistory(): Promise<HistoryItem[]> {
  const items: HistoryItem[] = []

  const moduleResults = await Promise.all(
    PARSER_KEYS.map((key) => fetchModuleTasks(key).then((tasks) => ({ key, tasks })).catch(() => ({ key, tasks: [] }))),
  )
  for (const { key, tasks } of moduleResults) {
    for (const t of tasks) {
      items.push({
        id: t.id,
        source: 'module',
        moduleKey: key,
        moduleLabel: MODULE_LABEL[key] ?? key,
        status: mapModuleStatus(t.status),
        date: t.createdAt,
        keywords: (t.settings.keywords ?? []).filter(Boolean),
        found: t.progress.total || t.progress.actionsDone || 0,
      })
    }
  }

  try {
    const imports = await fetchTgstatImports()
    for (const imp of imports) {
      items.push({
        id: `tg_${imp.id}`,
        source: 'tgstat',
        moduleKey: 'tgstat',
        moduleLabel: MODULE_LABEL.tgstat,
        status: mapTgstatStatus(imp.status),
        date: new Date(imp.created_at).getTime(),
        keywords: [imp.category, imp.region].filter(Boolean) as string[],
        found: imp.total_found || 0,
      })
    }
  } catch { /* tgstat недоступен */ }

  items.sort((a, b) => b.date - a.date)
  return items
}

/** Результаты для превью/экспорта конкретной записи. */
export async function fetchHistoryResults(item: HistoryItem): Promise<Record<string, unknown>[]> {
  if (item.source === 'tgstat') {
    return (await fetchTgstatChats(Number(item.id.replace('tg_', '')))) as unknown as Record<string, unknown>[]
  }
  const task = await fetchModuleTask(item.moduleKey, item.id)
  return task.results ?? []
}
