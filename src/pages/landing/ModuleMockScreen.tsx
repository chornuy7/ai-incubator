import { MODULE_FEATURES } from './catalog'

/**
 * §11.6: «как это выглядит внутри» — РЕНДЕР экрана модуля в коде (без картинок).
 * Чётко при любом масштабе, тематично, объясняет себя. Два вида на модуль:
 *   • setup   — панель настройки (цели, тон/лимиты, включённые возможности);
 *   • results — лента результатов + сводка за день.
 * Контент берём из возможностей модуля (они уже написаны языком выгоды) + типовые
 * для платформы значения (лимиты, задержки) — не выдумывая конкретных чужих цифр.
 */

/** Правдоподобные «цели/источник» под каждый модуль — что стоит в шапке экрана. */
const TARGETS: Record<string, string> = {
  'neuro-commenting': 'Каналы: 12 · @crypto_daily, @trade_signals …',
  'neuro-chatting': 'Группы: 8 · @defi_chat, @nft_talk …',
  'neuro-dialogs': 'Личные диалоги · входящие заявки',
  'mass-react': 'Каналы/группы: 20 · реакции 👍❤️🔥',
  'mass-looking': 'Каналы: 34 · Stories + посты',
  warming: 'Аккаунты в прогреве: 15',
  parsing: 'Ключи: «крипта», «трейдинг» · гео UA/RU',
  autoposting: 'Свои каналы: 3 · очередь постов',
  ggr: 'Проверка: 50 аккаунтов',
}

/** Строки «результатов» под модуль (лента событий). */
const RESULTS: Record<string, string[]> = {
  'neuro-commenting': ['✓ Коммент в @crypto_daily — «согласен, важный разбор…»', '✓ Коммент в @trade_signals — «а как насчёт рисков?»', '✓ Лид: @user_4821 заинтересовался', '✓ Коммент в @defi_news — «спасибо за подборку»'],
  'neuro-chatting': ['✓ Ответ в @defi_chat — ведём к цели', '✓ @nft_talk: вопрос → ответ по контексту', '✓ Лид «горячий»: передан в CRM', '✓ Ответ на языке собеседника (EN)'],
  'neuro-dialogs': ['✓ ЛС @client_12: ответ по промпту', '✓ Квалификация: бюджет уточнён', '✓ Лид → CRM, статус «интересуется»', '✓ Ответ ночью (03:14)'],
  'mass-react': ['✓ 👍 на пост @crypto_daily', '✓ 🔥 на пост @trade_signals', '✓ ❤️ на пост @defi_news', '✓ Охват без текста — быстро'],
  'mass-looking': ['✓ Просмотр Stories @channel_7', '✓ Просмотр постов @channel_12', '✓ Мягкая засветка в ленте', '✓ Заодно прогрев аккаунта'],
  warming: ['✓ Имитация активности акк. #3', '✓ Отдых после серии действий', '✓ Распорядок дня соблюдён', '✓ Trust ↑ 74 → 78'],
  parsing: ['✓ Найдено групп: 128', '✓ После фильтров: 41', '✓ Дедуп: −12 дублей', '✓ Готово для чаттинга/рассылок'],
  autoposting: ['✓ Пост в @my_channel по расписанию', '✓ Очередь: 6 постов', '✓ Публикация 18:00 — ок', '✓ Без ручной рутины'],
  ggr: ['✓ Оценка акк. #1: «живой» 82', '✓ Акк. #2: «риск» 34 — в карантин', '✓ Отчёт по 50 аккаунтам', '✓ AIR-рейтинг обновлён'],
}

function base(moduleKey: string): string {
  // «parsing-*» и т.п. → базовый ключ для наборов TARGETS/RESULTS.
  return moduleKey.startsWith('parsing') ? 'parsing' : moduleKey
}

export function ModuleMockScreen({ moduleKey, kind }: { moduleKey: string; kind: 'setup' | 'results' }) {
  const b = base(moduleKey)
  const feats = (MODULE_FEATURES[moduleKey] || MODULE_FEATURES[b] || []).slice(0, 4)
  const target = TARGETS[b] || 'Источник данных настроен'
  const results = RESULTS[b] || feats.map((f) => `✓ ${f}`)

  if (kind === 'results') {
    return (
      <div className="space-y-2 p-3">
        <div className="flex items-center justify-between rounded-lg border border-line bg-card px-3 py-2 text-[11px]">
          <span className="text-muted">Сегодня</span>
          <span className="font-semibold text-fg">128 действий · 3 лида · 0 флудвейтов</span>
        </div>
        {results.map((r, i) => (
          <div key={i} className="flex items-start gap-2 rounded-lg border border-line bg-card px-3 py-2 text-[12px] leading-snug">
            <span className="mt-0.5 text-spark-400">✓</span>
            <span className="min-w-0 flex-1 truncate text-muted">{r.replace(/^✓\s*/, '')}</span>
            <span className="shrink-0 text-[10px] text-faint">12:0{i}</span>
          </div>
        ))}
      </div>
    )
  }

  // setup
  return (
    <div className="space-y-2.5 p-3">
      {/* Цель/источник */}
      <div className="rounded-lg border border-spark-500/25 bg-spark-500/8 px-3 py-2">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-spark-300/80">Цель / источник</div>
        <div className="mt-0.5 text-[12px] text-fg">{target}</div>
      </div>
      {/* Возможности как включённые настройки */}
      {feats.map((f, i) => (
        <div key={f} className="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-spark-500/15 text-[11px] font-bold text-spark-300">{i + 1}</span>
          <span className="min-w-0 flex-1 truncate text-[12px] text-muted">{f}</span>
          {/* «Тумблер включено» — намекает, что это настраиваемый блок. */}
          <span className="relative h-4 w-7 shrink-0 rounded-full bg-spark-500/30">
            <span className="absolute right-0.5 top-0.5 h-3 w-3 rounded-full bg-spark-400" />
          </span>
        </div>
      ))}
      {/* Типовые safety-параметры платформы */}
      <div className="flex flex-wrap gap-1.5 pt-0.5">
        {['Лимит 15/день', 'Задержка 30–120с', 'Распорядок дня', 'Агент: тон+запреты'].map((t) => (
          <span key={t} className="rounded-md border border-line bg-surface px-2 py-1 text-[10px] text-muted">{t}</span>
        ))}
      </div>
    </div>
  )
}
