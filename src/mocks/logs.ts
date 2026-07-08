import type { LogEntry, LogLevel } from '@/shared/types'
import { pick } from '@/shared/lib/utils'

const ACCOUNTS = [
  'zubastik · 380630415146', 'Claude Bet AI · 380972700403', 'stakehodler · 380636086506',
  'Каролина · 380636086453', 'alina_m · 380671234501', 'bogdan_tg · 380661000042',
]

const TEMPLATES: Record<string, { level: LogLevel; msg: string }[]> = {
  'neuro-commenting': [
    { level: 'info', msg: 'Аккаунт подключился, начинаю мониторинг каналов' },
    { level: 'info', msg: 'Найден новый пост в @crypto_daily, готовлю комментарий' },
    { level: 'success', msg: 'Комментарий опубликован под постом #4821' },
    { level: 'info', msg: 'Генерация ответа моделью (системный промпт #3)' },
    { level: 'warning', msg: 'Медленный ответ канала, повтор через 20с' },
    { level: 'error', msg: 'Комментарии в @closed_channel отключены, пропуск' },
    { level: 'success', msg: 'Органическое продвижение: +1 лайк на комментарий' },
  ],
  'neuro-chatting': [
    { level: 'info', msg: '@cryptanytuy: канал, а не группа — пропуск' },
    { level: 'info', msg: 'Ожидание 102с перед вступлением...' },
    { level: 'info', msg: '@cryptogeimer: канал, а не группа — пропуск' },
    { level: 'success', msg: 'Вступил в Hackless [147/153 new] (задержка 109с)' },
    { level: 'info', msg: 'Ожидание 88с перед вступлением...' },
    { level: 'success', msg: 'Отправлен ответ на упоминание в @smm_chat' },
    { level: 'warning', msg: 'Флуд-контроль: пауза 60с' },
    { level: 'info', msg: '@block365hub: канал, а не группа — пропуск' },
  ],
  'mass-react': [
    { level: 'info', msg: 'Мониторинг новых сообщений в 93 группах' },
    { level: 'success', msg: 'Поставлена реакция 🔥 на пост #1204' },
    { level: 'success', msg: 'Поставлена реакция ❤️ на пост #1205' },
    { level: 'warning', msg: 'Реакции ограничены в @vip_group, интервал 120с' },
    { level: 'info', msg: 'Ротация аккаунта для следующей цели' },
  ],
  'mass-looking': [
    { level: 'info', msg: 'Просмотр поста #' },
    { level: 'info', msg: 'Просмотр сторис аккаунта' },
    { level: 'success', msg: 'Набор просмотров выполнен: 0/95' },
  ],
  warming: [
    { level: 'info', msg: 'Старт окна активности (UTC+3)' },
    { level: 'success', msg: 'Подписка на рекомендованный канал' },
    { level: 'info', msg: 'Скролл ленты, имитация чтения 30м' },
    { level: 'success', msg: 'Экономный режим: минимальные действия' },
  ],
  'neuro-dialogs': [
    { level: 'info', msg: 'Загружена история ЛС (5 сообщений)' },
    { level: 'success', msg: 'Ответ по сценарию отправлен' },
    { level: 'info', msg: 'Сработал триггер «интерес к продукту»' },
  ],
  'parsing-messages': [
    { level: 'info', msg: 'Сбор сообщений из истории групп' },
    { level: 'success', msg: 'Собрано 4 автора' },
    { level: 'warning', msg: 'Часть сообщений скрыта настройками приватности' },
    { level: 'error', msg: 'Группа недоступна для парсинга' },
  ],
}

const DEFAULT: { level: LogLevel; msg: string }[] = [
  { level: 'info', msg: 'Задача запущена' },
  { level: 'success', msg: 'Шаг выполнен успешно' },
  { level: 'warning', msg: 'Небольшая задержка, продолжаю' },
]

function ts(i: number): string {
  const base = 12 * 3600 + 4 * 60 // 12:04:00
  const total = base - i * 37
  const h = Math.floor(total / 3600) % 24
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}`
}

/** Детерминированный набор мок-логов для модуля. */
export function seedLogs(moduleKey: string, count: number): LogEntry[] {
  const pool = TEMPLATES[moduleKey] ?? DEFAULT
  return Array.from({ length: count }, (_, i) => {
    const t = pool[i % pool.length]
    return {
      id: `${moduleKey}-log-${i}`,
      ts: ts(i),
      level: t.level,
      account: pick(ACCOUNTS, i + moduleKey.length),
      message: t.msg + (t.msg.endsWith('#') ? String(1000 + i) : ''),
    }
  })
}
