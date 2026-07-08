import { MODULES } from '@/shared/config/modules'
import { LiveModule } from './LiveModule'
import { NeuroDialogsModule } from '@/features/neuro-dialogs/NeuroDialogsModule'

/** Все модули панели с реальным API-бэкендом. */
const LIVE_KEYS = new Set(Object.keys(MODULES))

export function ModuleLiveRouter({ moduleKey }: { moduleKey: string }) {
  if (moduleKey === 'neuro-dialogs') return <NeuroDialogsModule />
  if (!LIVE_KEYS.has(moduleKey)) return null
  return <LiveModule moduleKey={moduleKey} />
}

export function isLiveModule(moduleKey: string) {
  return LIVE_KEYS.has(moduleKey)
}

export { LiveModule } from './LiveModule'
