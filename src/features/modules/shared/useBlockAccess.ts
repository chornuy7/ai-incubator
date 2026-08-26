import { useSession } from '@/features/auth/session'
import { can } from '@/shared/lib/access'

/**
 * Виден ли блок модуля этому пользователю.
 *
 * Проверка была ТОЛЬКО в LiveModule — то есть у парсеров и нейродиалогов выданные права
 * на блоки не действовали вовсе: в админке тумблер щёлкали, а на экране ничего не
 * менялось (находка 26.08 по просьбе владельца «проверить, работают ли они вообще»).
 *
 * Правило «ничего не настраивали — не ограничиваем». Пустой ключ означает запрет, поэтому
 * без этой оговорки включение проверки в парсерах мгновенно спрятало бы у сотрудников все
 * разделы — они этих тумблеров никогда не касались. А как только по модулю выставлен хоть
 * один блок (пусть даже все в «запрет»), правила применяются полностью: это уже осознанная
 * настройка, и её надо уважать.
 */
export function useBlockAccess(moduleKey: string): (blockKey: string) => boolean {
  const sessionUser = useSession((s) => s.user)
  return (blockKey: string) => {
    if (!sessionUser || sessionUser.isAdmin) return true
    const perms = sessionUser.permissions
    if (!perms) return false
    const prefix = `${moduleKey}:`
    const configured = Object.keys(perms.blocks || {}).some((k) => k.startsWith(prefix))
    if (!configured) return true
    return can(perms, false, 'block', `${prefix}${blockKey}`)
  }
}
