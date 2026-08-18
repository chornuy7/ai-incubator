# CONTRACT · Журнал действий модулей (лог действий)

> Проект хранения действий по **LOG-001** (ТЗ 06.08, `docs/TZ-2026-08-06.md`).
> Задача-дизайн: **MR-120** «Спроектировать хранение действий».
> Реализация записи: **MR-121** «Записывать действия модулей» (этот контракт — её вход).
> Источник истины кода (после MR-121): `server/actionLog.js` + миграция
> `supabase/migrations/2026-08-18-module-actions.sql`.

## 1. Зачем ещё один журнал — и чем он отличается от соседних

В системе уже есть три потока, и действие модуля не ложится целиком ни в один:

| Поток | Что хранит | Где | Почему не подходит для LOG-001 |
|---|---|---|---|
| **Аудит** (`CONTRACT-audit-log`) | Платформенные события «кто/что/когда/почему»: смена статуса, старт/стоп задачи, перенос профиля | `audit_log` | Это действия **человека/системы над платформой**, а не действия **бота в Telegram** |
| **Операционный лог задачи** | Пошаговый текст воркера («Коммент: …», «Суточный лимит») | `task.logs` | Свободный текст для чтения глазами, не queryable, живёт внутри одной задачи |
| **Активность аккаунта** | Усталость, отдых, суточные счётчики | `account_activity` | Агрегаты для допуска к работе, без единичных действий и без объекта/текста |
| **Истории задач** | `commentHistory` / реакции / диалоги / `results` | внутри `task` | **Фрагментированы**: 5 разных форм записи, разные поля, не связаны и не индексируются |

**Журнал действий** (этот контракт) — единый, структурированный, queryable след **каждого
действия, которое бот совершил в Telegram**: пост, комментарий, реакция, чат/ЛС. Отвечает
на «какой аккаунт, что именно, где, когда, по какой задаче сделал — и как отреагировала
аудитория». Из него растут: экран «Логи» по действиям, аналитика эффективности, будущий
CRM-слой (ответы аудитории → лиды).

## 2. Единая модель действия (`module_actions`)

Одно действие = одна запись. Поля — прямое покрытие критериев приёмки LOG-001
(тип · аккаунт · группа/канал · ссылка на объект · дата/время · текст/значение ·
связанная задача/запуск · ответы и реакция аудитории):

```jsonc
{
  "id":         "act_<taskId>_<seq>",     // стабильный uid действия
  "ts":         "ISO-8601",               // ← дата/время (когда совершено)
  "type":       "comment",                // ← тип, см. §3
  "status":     "sent",                   // sent | failed | pending

  // ← аккаунт (кто сделал)
  "accountId":  "acc_9c93…",
  "accountName":"Zachary Combs",          // денормализовано для лога без джойна

  // ← группа/канал (где) и ссылка на объект (над чем)
  "target":     "@cryptoz",               // @handle или числовой id peer
  "targetTitle":"Cryptoz",                // человекочитаемое имя канала/группы
  "objectRef":  { "postId": 12345,        // на что нацелено действие: пост/сообщение
                  "url": "https://t.me/cryptoz/12345",
                  "replyToId": null },     // для чата — сообщение, на которое отвечаем

  // ← текст/значение (что именно)
  "value":      { "text": "Отличный разбор!",  // для коммента/чата/ЛС
                  "emoji": null,               // для реакции («👍»)
                  "kind": null },              // доп. под-тип, если нужен

  // ← связанная задача/запуск
  "moduleKey":  "neuro-commenting",
  "taskId":     "nc_5cd350cd",
  "launchId":   "nc_5cd350cd#3",          // конкретный запуск (restart создаёт новый)
  "goalId":     null,                     // если задача под целью (CRM)
  "initiator":  "operator",               // кто запустил задачу (для сквозной атрибуции)

  // ← ответы и реакция аудитории (заполняется отложенно, §5)
  "audience":   { "repliesCount": 0,      // сколько ответили на наше действие
                  "reactionsCount": 0,    // сколько реакций собрал наш пост/коммент
                  "reactions": {},         // разбивка по эмодзи: {"👍":3,"🔥":1}
                  "replies": [],           // краткие ссылки/тексты ответов (лиды)
                  "checkedAt": null },     // когда последний раз опрашивали аудиторию

  "meta":       {},                        // модуль-специфичное расширение
  "createdAt":  "ISO-8601"                 // когда запись легла в журнал
}
```

Обязательные после нормализации: `id, ts, type, status, accountId, moduleKey, taskId`.
Остальное — best-effort: чего воркер не знает (`targetTitle`, `objectRef.url`), то не
выдумываем, оставляем пустым. `audience` при записи всегда нулевой — его дополняет
отдельный проход (§5).

## 3. Словарь `type` (расширяемый)

| `type` | Действие | `value` | Источник сейчас |
|---|---|---|---|
| `post` | Публикация поста (автопостинг) | `text`, вложения в `meta` | autoposting |
| `comment` | Комментарий под постом канала | `text` | `commentHistory` (workers.js ~555) |
| `reaction` | Реакция на пост | `emoji` | реакции (workers.js ~872) |
| `chat` | Сообщение в группе/чате (нейрочат) | `text` | чат-reply (workers.js ~710) |
| `dialog` | Ответ в личном диалоге (нейродиалоги) | `text` | dialog-reply (workers.js ~1476) |
| `dm` | ЛС в рассылке (мейлинг) | `text` | mailing |
| `join` | Вступление в группу/канал | — | `incAction(…, 'joins')` |

Прогрев (`warming`) генерит служебные действия (просмотры/вступления) — логируем те из
них, что имеют объект (`join`, `reaction`); чистые просмотры остаются в `task.logs`.

## 4. Карта: текущие фрагменты → единая модель

Что MR-121 заменяет/сводит (сейчас это разные `appendHistory`-формы):

| Сейчас | Поле единой модели |
|---|---|
| `commentHistory: {accountName, channel, comment, status, ts}` | `type:'comment'`, `accountName`, `target=channel`, `value.text=comment`, `status`, `ts` |
| реакция `{accountName, target, emoji, postId, status}` | `type:'reaction'`, `target`, `value.emoji`, `objectRef.postId`, `status` |
| чат/диалог `{accountName, target, text, status}` | `type:'chat'`/`'dialog'`, `target`, `value.text`, `status` |
| `task.accountStats[id].actions++` | остаётся как **агрегат** (быстрый счётчик); журнал — источник для его пересчёта |
| `incAction(id, kind)` (суточный лимит) | остаётся; журнал не заменяет лимиты, но сверяем по нему |

Агрегаты (`accountStats`, `account_activity`) **не удаляются** — они горячий кэш; журнал
действий — холодный источник истины, из которого их можно пересчитать.

## 5. Ответы и реакция аудитории (отложенное обогащение)

Реакцию аудитории нельзя знать в момент действия — она появляется позже. Поэтому:

1. При записи действия `audience` нулевой.
2. Отдельный проход (планировщик, вне горячего цикла воркера) периодически берёт свежие
   действия с объектом (`objectRef.postId`/`messageId`), опрашивает Telegram и заполняет
   `audience.reactionsCount/reactions` (реакции на наш пост/коммент) и
   `audience.replies/repliesCount` (ответы на него). Ставит `checkedAt`.
3. Ответы (`replies`) — вход для CRM (§ARCH-goals-crm): ответивший = потенциальный лид,
   привязанный к `goalId`/`launchId`.

Частоту и глубину опроса задаёт MR-121+; контракт лишь фиксирует **место** этих данных.

## 6. Хранилище и API (реализует MR-121)

Паттерн — как у `audit_log`/`account_activity`: `listStore` (`server/lib/tableStore.js`)
поверх Supabase-таблицы с фолбэком на файл. Код и миграция не обязаны совпадать по
времени: нет таблицы → пишем в `data/module-actions.jsonl`, аудит не теряется.

```
recordAction(input) → entry     // нормализует (§2) и дописывает; вызывается воркером после успешного действия
enrichAudience(ids?) → n        // отложенный проход §5
readActions({ limit, type?, accountId?, taskId?, moduleKey?, target?, since?, until? }) → entry[]  // новые сверху
buildActionEntry(input) → entry // чистая нормализация (юнит-тесты)
```

Запись — **best-effort и не роняет действие**: как `recordTokens`, сбой журналирования
логируется, но коммент/реакция уже отправлены — откатывать нельзя.

### Предлагаемая схема (миграция `2026-08-18-module-actions.sql`)

```sql
create table if not exists module_actions (
  id         text primary key,
  ts         timestamptz not null default now(),
  type       text not null,
  status     text not null default 'sent',
  account_id text,
  account_name text,
  target     text,
  target_title text,
  object_ref jsonb not null default '{}'::jsonb,
  value      jsonb not null default '{}'::jsonb,
  module_key text,
  task_id    text,
  launch_id  text,
  goal_id    text,
  initiator  text,
  audience   jsonb not null default '{}'::jsonb,
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists module_actions_ts_idx      on module_actions (ts desc);
create index if not exists module_actions_task_idx    on module_actions (task_id);
create index if not exists module_actions_account_idx on module_actions (account_id);
create index if not exists module_actions_type_idx    on module_actions (type);
comment on table module_actions is 'Журнал действий модулей (LOG-001): пост/коммент/реакция/чат/ЛС — что бот сделал в Telegram, над каким объектом и как отреагировала аудитория.';
```

## 7. Объём, ретеншн, приватность

- **Объём**: действий на порядок больше аудита (каждый коммент/реакция). Ретеншн —
  ротацией по возрасту/размеру (env `ACTION_LOG_KEEP_DAYS`, default 90), а не «навсегда»:
  холодные действия старше горизонта аналитики можно свёртывать в агрегаты.
- **Приватность/scope**: доступ к журналу — через владельца (по `accountId` → владелец
  аккаунта), как и остальные данные. Тексты действий (`value.text`) — данные клиента,
  под RLS наравне с задачами.
- **RLS**: политику на `module_actions` завести вместе с общим RLS-планом (`docs`), не
  оставлять таблицу открытой.

## 8. Инвариант

Журнал **append-only**: запись о действии не редактируется (кроме дозаполнения `audience`
и `status: pending→sent/failed`) и не удаляется вручную (только ротация по ретеншну).
Любое действие бота, имеющее объект в Telegram (пост, комментарий, реакция, сообщение,
ЛС, вступление), обязано оставить запись с `accountId`, `type`, `taskId` и `ts`.
