# CONTRACT · Единый аудит-лог

> Контракт Фазы 0 (Lane A+B). Источник истины кода — `server/lib/auditLog.js`
> (`buildAuditEntry` — чистая функция, покрыта юнит-тестами). ТЗ: §3.1, §5.

## 1. Два потока логов — не путать

| Поток | Что это | Где |
|---|---|---|
| **Аудит** (этот контракт) | Неизменяемый append-only след значимых событий: смена статуса, перенос профиля, массовое действие, force-снятие лока, старт/стоп задачи, запуск кампании | `data/audit.log.jsonl`, экран **«Логи»** (`/panel/logs`) |
| **Операционные логи задачи** | Пошаговый лог конкретного воркера (что делал бот) | `task.logs` (`taskStore.appendLog`), внутри карточки задачи |

Аудит отвечает на «кто/что/когда/почему» на уровне платформы (§5.2 — видно инициатора);
операционные логи — на «как шло выполнение» внутри одной задачи.

## 2. Формат записи (`buildAuditEntry`)

Каждая строка `audit.log.jsonl` — один JSON-объект:

```jsonc
{
  "id":        "8-символьный uuid-срез",   // авто
  "ts":        "ISO-8601",                 // авто (new Date().toISOString())
  "action":    "status.change",            // тип события (см. §3), default "legacy"
  "module":    "core",                     // ключ модуля-источника, default "core"
  "initiator": "operator",                 // кто инициировал (см. §4), default "system"
  "code":      "FLOODWAIT",                // машинный код причины, default ""
  "reason":    "Telegram FloodWait 3600s", // человекочитаемая причина, default ""
  "scope":     { "accounts": ["id1"] },    // затронутый объём, default {}
  "account":   "id1",                      // опц.: если событие об одном аккаунте
  "meta":      { "from": "active", "to": "floodwait" } // опц.: доп. контекст
}
```

Обязательные после нормализации: `id, ts, action, module, initiator, code, reason, scope`.
`account` и `meta` добавляются только если переданы. Соответствие ТЗ §3.1
«action, module, profile, initiator, time, reason/code, affectedScope»:
`profile → account/scope.accounts`, `time → ts`, `affectedScope → scope`.

## 3. Словарь `action` (расширяемый)

Значение свободное, но придерживаемся неймспейсов: `status.change`, `account.move`,
`account.bulkMove`, `lock.forceRelease`, `task.start`, `task.stop`, `campaign.launch`,
`channel.stats`. Новые типы добавлять сюда при вводе.

## 4. Словарь `initiator`

- `operator` — действие человека из UI (передаётся с фронта, напр. `patchAccount({initiator:'operator'})`);
- `scheduler` — планировщик/авто-расписание (статистика каналов, кампании по таймеру);
- `worker` — сам воркер модуля (напр. авто-перевод в `floodwait`);
- `system` — служебное/загрузочное согласование (default).

## 5. API

- `appendAudit(input) → entry` — нормализует и дописывает строку; создаёт файл при
  отсутствии; best-effort ротация.
- `readAudit({ limit=200, action?, initiator?, account? }) → entry[]` — читает,
  фильтрует, отдаёт **новые сверху**. Фильтр `account` матчит и `entry.account`,
  и вхождение в `scope.accounts`.
- `buildAuditEntry(input)` — чистая нормализация (для тестов и переиспользования).

Экран «Логи» использует `readAudit` + клиентские фильтры по `action` и `initiator`
+ детальная вью записи по клику (действие/инициатор/код/причина/scope/meta).

## 6. Ротация

При `size > AUDIT_MAX_BYTES` (default 2 MiB) файл обрезается до последних
`AUDIT_KEEP_LINES` (default 5000) строк. Ротация best-effort — сбой ротации не
ломает запись. Всё переопределяется env (`AUDIT_LOG_FILE`, `AUDIT_MAX_BYTES`,
`AUDIT_KEEP_LINES`) для изоляции в тестах.

## 7. Инвариант

Аудит **append-only**: строки не редактируются и не удаляются (кроме обрезки старых
при ротации). Любое действие, меняющее статус аккаунта, переносящее профиль между
задачами, снимающее лок силой или запускающее/останавливающее задачу — обязано
оставить аудит-запись с `initiator` и `reason/code`.
