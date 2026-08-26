import { useEffect, useState } from 'react'
import { Copy, Terminal, KeyRound, BookOpen, ShieldCheck, ShieldAlert, Database } from 'lucide-react'
import { Card } from '@/shared/ui'
import { useApp } from '@/mocks/store'
import { serviceKeyStatus, presetsToDb } from '@/api/adminApi'

/**
 * §10.3: вкладка «API» в админ-панели — документация «мозгам».
 *
 * Ключ здесь НЕ выпускается: приватный API — это «мозги» проекта, один сервисный ключ
 * живёт только в окружении сервера (`MURMEX_API_KEY`), не в БД и не в интерфейсе. Так
 * его нельзя выбрать/утащить через панель тому, у кого есть к ней доступ. Подключение —
 * этим ключом через обычный API или MCP-манифест.
 */

/** Базовый URL API берём с текущего домена — чтобы примеры были с рабочим адресом. */
function apiBase() {
  try { return `${window.location.origin}/api/v1` } catch { return 'https://myrmexgram.ai/api/v1' }
}

interface Endpoint {
  method: string
  path: string
  title: string
  body?: string
}

const ENDPOINTS: Endpoint[] = [
  { method: 'GET', path: '/me', title: 'От чьего имени работает ключ (владелец из MURMEX_API_KEY_OWNER, иначе — система)' },
  { method: 'GET', path: '/capabilities', title: 'Что умеет каждый модуль (цели, цены, как запускать)' },
  { method: 'GET', path: '/mcp', title: 'Те же возможности как MCP-манифест инструментов (для AI-оркестратора)' },
  { method: 'POST', path: '/goals', title: 'Создать цель (измеримый результат)', body: '{ "name": "200 переходов", "metric": { "kind": "clicks", "target": 200 } }' },
  { method: 'POST', path: '/campaigns', title: 'Создать кампанию под цель', body: '{ "name": "Крипто · этап 1", "modules": ["neuro-commenting"], "goalId": "goal_…" }' },
  { method: 'POST', path: '/modules/:key/estimate', title: 'Оценить стоимость и время ДО запуска', body: '{ "actions": 100 }' },
  { method: 'POST', path: '/modules/:key/run', title: 'Запустить модуль (только на аккаунтах пользователя)', body: '{ "accountIds": ["acc_…"], "targets": ["@channel"], "maxActions": 50, "goalId": "goal_…" }' },
]

export function ApiDocsTab() {
  const pushToast = useApp((s) => s.pushToast)
  const base = apiBase()
  const [copied, setCopied] = useState('')
  const [configured, setConfigured] = useState<boolean | null>(null)
  useEffect(() => { void serviceKeyStatus().then((s) => setConfigured(s.configured)).catch(() => setConfigured(null)) }, [])
  const copy = (v: string, id = '') => {
    void navigator.clipboard?.writeText(v)
    setCopied(id); setTimeout(() => setCopied(''), 1200)
    pushToast({ type: 'success', title: 'Скопировано' })
  }

  const curlExample = `curl ${base}/capabilities \\
  -H "Authorization: Bearer $MURMEX_API_KEY"`

  return (
    <div className="space-y-4">
      <PresetsToDbCard />
      {/* 1. Где живёт ключ «мозгов» */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-bold text-fg"><KeyRound size={15} /> Сервисный ключ «мозгов»</div>
        <p className="mt-1 text-xs text-muted">
          Приватный API — это «мозги» проекта. Ключ <b className="text-fg">не выпускается здесь</b> и не
          хранится в базе: он живёт только в окружении сервера, чтобы его нельзя было выбрать
          или утащить через панель. Один ключ на всю систему — им «мозги» и MCP-клиенты
          создают цели/кампании и запускают модули.
        </p>
        <div className="mt-3 rounded-lg border border-line bg-bg p-3">
          <div className="text-xs font-semibold text-muted">Задать на сервере (env), затем перезапустить процесс:</div>
          <pre className="mt-1.5 overflow-x-auto whitespace-pre font-mono text-xs text-fg">{`MURMEX_API_KEY=aii_live_sk_<длинная_случайная_строка>
# необязательно: действовать от имени конкретного пользователя продукта
MURMEX_API_KEY_OWNER=usr_...`}</pre>
          <div className="mt-2 text-[11px] leading-relaxed text-faint">
            Без <code>MURMEX_API_KEY_OWNER</code> ключ работает как система (полный доступ).
            С ним — от имени этого пользователя, с его правами и аккаунтами.
          </div>
        </div>
        <div className="mt-3">
          {configured === null ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-elevated/40 px-2.5 py-1 text-xs text-muted">Статус ключа неизвестен</span>
          ) : configured ? (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-spark-500/30 bg-spark-500/10 px-2.5 py-1 text-xs font-semibold text-spark-300"><ShieldCheck size={13} /> Ключ задан в окружении сервера</span>
          ) : (
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-300"><ShieldAlert size={13} /> Ключ не задан — API закрыт, пока не появится MURMEX_API_KEY</span>
          )}
        </div>
      </Card>

      {/* 2. Как подключиться */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-bold text-fg"><BookOpen size={15} /> Как подключиться (API / MCP)</div>
        <p className="mt-1 text-xs text-muted">
          Любой запрос — с заголовком <code>Authorization: Bearer &lt;ключ&gt;</code>. MCP-клиент берёт
          список инструментов из <code>GET /mcp</code>, а вызывает их обычными POST ниже. Кто владелец
          ключа — <code>GET /me</code>. Без ключа или с неверным — <b>401</b>.
        </p>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">Базовый адрес</div>
            <button onClick={() => copy(base, 'base')} className="flex w-full items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-left">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">{base}</code>
              <Copy size={13} className={copied === 'base' ? 'text-spark-400' : 'text-muted'} />
            </button>
          </div>
          <div>
            <div className="mb-1 text-xs font-semibold text-muted">Авторизация (в каждом запросе)</div>
            <button onClick={() => copy('Authorization: Bearer aii_live_sk_…', 'auth')} className="flex w-full items-center gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-left">
              <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg">Authorization: Bearer aii_live_sk_…</code>
              <Copy size={13} className={copied === 'auth' ? 'text-spark-400' : 'text-muted'} />
            </button>
          </div>
        </div>

        <div className="mt-4">
          <div className="mb-1 flex items-center gap-1.5 text-xs font-semibold text-muted"><Terminal size={12} /> Проверка ключа (curl)</div>
          <button onClick={() => copy(curlExample, 'curl')} className="flex w-full items-start gap-2 rounded-lg border border-line bg-bg px-3 py-2 text-left">
            <pre className="min-w-0 flex-1 overflow-x-auto whitespace-pre font-mono text-xs text-fg">{curlExample}</pre>
            <Copy size={13} className={`mt-0.5 shrink-0 ${copied === 'curl' ? 'text-spark-400' : 'text-muted'}`} />
          </button>
        </div>
      </Card>

      {/* 3. Эндпоинты */}
      <Card className="p-5">
        <div className="flex items-center gap-2 text-sm font-bold text-fg"><KeyRound size={15} /> Эндпоинты</div>
        <div className="mt-3 overflow-x-auto">
          <div className="min-w-[560px] space-y-1.5">
            {ENDPOINTS.map((e) => (
              <div key={e.method + e.path} className="rounded-lg border border-line bg-bg p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${e.method === 'GET' ? 'bg-iris-500/15 text-iris-300' : 'bg-spark-500/15 text-spark-300'}`}>{e.method}</span>
                  <code className="font-mono text-xs text-fg">{e.path}</code>
                  <span className="text-xs text-muted">{e.title}</span>
                </div>
                {e.body && (
                  <button onClick={() => copy(e.body!, e.path)} className="mt-1.5 flex w-full items-center gap-2 rounded border border-line/60 bg-elevated/40 px-2 py-1 text-left">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-[11px] text-muted">{e.body}</code>
                    <Copy size={11} className={copied === e.path ? 'text-spark-400' : 'text-faint'} />
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
        <p className="mt-3 text-xs text-muted">
          <code>:key</code> — ключ модуля из <code>/capabilities</code> (напр. <code>neuro-commenting</code>).
          Без ключа или с отозванным любой запрос вернёт <b>401</b>.
        </p>
      </Card>
    </div>
  )
}

/**
 * Разовый перенос шаблонов настроек из файлов сервера в общую базу.
 *
 * До 26.08 шаблоны хранились в файлах на сервере: локальная копия и прод показывали разные
 * наборы, а второй инстанс развёл бы их окончательно. Теперь они в базе, но старые файлы
 * надо перенести один раз. Прочитать их может ТОЛЬКО серверный процесс — ни из браузера,
 * ни запросом к базе до них не добраться, поэтому кнопка здесь, а не «сделайте SQL».
 *
 * Сначала показывает, что перенесёт, и ничего не пишет. Перенос — вторым нажатием.
 * Повторный запуск безопасен: модуль, где в базе уже есть шаблоны, пропускается.
 */
function PresetsToDbCard() {
  const pushToast = useApp((s) => s.pushToast)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<Awaited<ReturnType<typeof presetsToDb>> | null>(null)

  const run = async (apply: boolean) => {
    setBusy(true)
    try {
      const r = await presetsToDb(apply)
      setReport(r)
      pushToast({
        type: 'success',
        title: apply ? 'Шаблоны перенесены' : 'Показ: ничего не записано',
        desc: apply ? `Перенесено: ${r.moved}` : `Будет перенесено: ${r.moved}`,
      })
    } catch (e) {
      pushToast({ type: 'error', title: 'Не получилось', desc: e instanceof Error ? e.message : '' })
    } finally { setBusy(false) }
  }

  return (
    <Card className="p-5">
      <div className="flex items-center gap-2 text-sm font-bold text-fg"><Database size={15} /> Шаблоны настроек: перенос в базу</div>
      <p className="mt-1 text-xs text-muted">
        Разовое действие. Старые шаблоны лежат файлами на сервере — переносим их в общую базу,
        чтобы они были одинаковыми везде. Файлы остаются на месте: если что-то пойдёт не так,
        откатиться есть куда. Повторное нажатие ничего не испортит — модули, которые уже в базе, пропускаются.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => void run(false)} className="btn-ghost h-9 text-xs disabled:opacity-40">
          Показать, что перенесётся
        </button>
        <button type="button" disabled={busy || !report || !report.moved} onClick={() => void run(true)} className="btn-primary h-9 text-xs disabled:opacity-40">
          Перенести
        </button>
      </div>
      {report && (
        <div className="mt-3 space-y-1 rounded-xl border border-line bg-elevated/40 p-3 text-xs">
          {report.items.length === 0 && <div className="text-muted">Переносить нечего — файлов с шаблонами нет.</div>}
          {report.items.map((it) => (
            <div key={it.moduleKey} className={it.error ? 'text-rose-300' : it.skipped ? 'text-faint' : 'text-fg'}>
              <b>{it.moduleKey}</b>{' '}
              {it.error
                ? `— ошибка: ${it.error}`
                : it.skipped
                  ? `— пропущен, в базе уже ${it.count}`
                  : `— ${report.apply ? 'перенесено' : 'будет перенесено'} ${it.count}${it.names.length ? `: ${it.names.join(', ')}` : ''}`}
            </div>
          ))}
          <div className="pt-1 text-muted">Итого: {report.moved}</div>
        </div>
      )}
    </Card>
  )
}
