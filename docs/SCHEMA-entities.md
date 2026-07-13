# Схема данных: сущности и граница платформы

> **Фаза 0 · Lane A+B.** Требования: [TZ-2026-07-10.md](./TZ-2026-07-10.md) §3.2–3.10, §4.
> Контракт схемы — фиксирует **имена сущностей, ключевые поля и границу «общий слой ↔ Telegram»**,
> чтобы дорожки не переопределяли одни и те же структуры. Текущее хранилище — JSON в `server/data/`
> (не БД); контракт описывает логическую модель, миграция на БД — вне Фазы 0.

## 1. Карта сущностей

```
Profile (человек-оператор)
   │ owns / assigns
   ▼
Account (бот) ──uses──> Proxy ──has──> SIM/Device        [Telegram-специфика через адаптер, §3.10]
   │
   │ locked/leased by
   ▼
Task (запуск модуля) ──targets──> Channel[]              [Channel — общий слой + tg-поля]
   │
   ├──runs toward──> Goal ──has──> KnowledgeBase[]
   │                   │
   ▼                   ▼
 Log/Audit          Lead (CRM) ──belongs to──> Goal, ──handled by──> Account
```

Легенда владения: **Profile/Task/Goal/KnowledgeBase/Lead/Channel** — общий слой (платформо-независимый).
**Account/Proxy/SIM** и tg-поля Channel — за адаптером платформы (§4 ниже).

## 2. Сущности (ключевые поля)

> `?` — необязательное; 🔒 — значение/набор требует решения (§6); _(есть)_ — уже реализовано в коде.

### Profile — пользователь системы (§3.2)
```jsonc
{ "id", "name", "role": "Admin|Operator|Sales|Viewer", // 🔒 роли — §6
  "createdAt", "updatedAt" }
```
Сейчас: понятия «Profile» в коде нет (есть только аккаунты). Скелет — Фаза 1/3. Не путать с `meta.project`.

### Account — управляемый бот (§3.2, §3.3) — _(есть: `accountsMeta.js`)_
```jsonc
{ "id", "phone", "country",              // _(есть)_ countryFromPhone()
  "role", "project",                     // _(есть)_ meta.role/project
  "status", "statusReason?", "statusSince?", "statusUntil?", "statusBy?", "prevStatus?", // см. CONTRACT-account-state-machine.md
  "proxyId?",                            // ссылка на Proxy (сейчас proxy инлайном в meta.proxy)
  "trustScore?",                         // 🔒 формула — §6
  "warmingUntil?", "inTrash",            // _(есть частично)_
  "createdAt", "updatedAt" }             // _(есть)_
```
**Платформа:** сессия (`.session`, GramJS), `apiId/apiHash` — Telegram-специфика, живут за адаптером.

### Proxy — сетевой доступ (§3.4) — _(есть частично: `server/proxy.js`, `meta.proxy`)_
```jsonc
{ "id", "url",                           // socks5://user:pass@host:port — _(есть, parseProxy)_
  "type": "static|mobile",               // §3.4
  "country?", "city?",                   // §3.4 GEO
  "simId?", "deviceId?", "imei?",        // §3.4 модель аккаунт→SIM→device — 🔒 (§6 инфраструктура)
  "working?", "checkedAt?",              // _(есть: proxyCheck/accountStats)_
  "rotationMin?" }                       // мобильные 3–5 мин (§3.4)
```
Сейчас прокси — строка `meta.proxy`. Контракт: вынести в отдельную сущность + перенести валидацию в Менеджер профилей (§3.2). Реализация — Фаза 3.

### Task — запуск модуля (§3.9) — _(есть: `lib/taskStore.js`)_
```jsonc
{ "id", "moduleKey", "status": "queued|running|paused|stopped|done|error", // _(есть, + paused новый)_
  "settings", "progress", "logs", "results", "accountStats",  // _(есть)_
  "goalId?", "channelIds?",              // §3.6/§3.7 привязка к цели и каналам (новое)
  "initiator?",                          // §4 кто запустил (аудит) — новое
  "createdAt", "updatedAt", "startedAt?" }  // _(есть)_
```
Расширяется, **не переписывается**: добавить `paused` в набор статусов, `goalId/channelIds/initiator`.
Владелец файла — Lane A (`taskStore`), поля целей согласуются с Lane B через этот контракт.

### Channel — целевой канал/группа (§3.7, §3.8)
```jsonc
{ "id",                                  // внутренний, стабильный
  "title", "link", "category?",          // §3.7
  "language?", "region?",                // §3.7/§4: язык ≠ регион — хранить раздельно!
  "subscribers?", "activity?",           // §3.7
  "hasComments?",                        // §3.8 статистический признак (не единств. сценарий)
  "rating?",                             // 🔒 прозрачная формула — §6/§3.8 (сейчас ★ по участникам, B1)
  "sources?", "categoriesExtra?",        // §3.8 дедуп: доп. категории/запуски, не дубль
  "lastStatsAt?", "statsBy?",            // §3.9 дата+источник обновления
  "tg": { "peerId", "username", "accessHash?" } } // ← Telegram-специфика, за адаптером
```
**Дедуп (§3.8/§4 «данные канала не теряются»):** ключ дедупа — `tg.username` / `tg.peerId`; повторный
парсинг обновляет карточку и добавляет в `sources/categoriesExtra`, а не создаёт новую запись.

### Goal — цель кампании (§3.6, P0)
```jsonc
{ "id", "name", "description",
  "targetAction",                        // целевое действие
  "stages?",                             // этапы движения к цели
  "completionCriteria",                  // критерий завершения
  "audience?",                           // аудитория
  "createdAt", "updatedAt" }
```

### KnowledgeBase — база знаний под цель (§3.6)
```jsonc
{ "id", "goalId", "kind": "text|file|image",
  "content?", "fileRef?",
  "version",                             // версионирование (§3.6)
  "scope",                               // область использования
  "createdAt" }
```
🔒 Форматы/размеры/OCR/vision — §6 (AI-файлы). Пока фиксируем только структуру ссылки.

### Lead — CRM-лид (§3.6)
```jsonc
{ "id", "goalId", "accountId",           // ответственный аккаунт
  "peer",                                // с кем диалог (tg-специфика — за адаптером)
  "status": "cold|answered|hot|target|closed",  // §3.6
  "dialogRef?",                          // история диалога
  "result?", "isHot",                    // «горячий лид» → влияет на state machine аккаунта
  "createdAt", "updatedAt" }
```
Подробный data flow — [ARCH-goals-crm.md](./ARCH-goals-crm.md).

## 3. Связи (кардинальность)

| Связь | Тип |
|---|---|
| Profile → Account | 1—N (оператор владеет пачкой ботов) |
| Account → Proxy | N—1 (каждый бот через прокси; §3.4) |
| Task → Account | N—N (задача на набор аккаунтов; `settings.accountIds`) |
| Task → Channel | N—N (`channelIds`) |
| Task → Goal | N—1 (§4: AI работает к цели) |
| Goal → KnowledgeBase | 1—N |
| Goal → Lead | 1—N |
| Lead → Account | N—1 (ответственный) |
| Channel ↔ Account (stats) | lease 1—1 в моменте (§3.9, «один канал — один бот») |

## 4. Граница «общий слой ↔ Telegram-специфика» (§3.10, адаптер платформы)

**Принцип (§3.10):** не тащить Telegram-поля в общий слой. Платформа подключается через адаптер.

```
┌─────────────────── ОБЩИЙ СЛОЙ (platform-agnostic) ───────────────────┐
│ Profile · Task · Goal · KnowledgeBase · Lead · Channel(core-поля)     │
│ Account(core: id/status/role/trust) · Proxy(core)                     │
└───────────────────────────────┬──────────────────────────────────────┘
                                 │  PlatformAdapter (интерфейс)
                 ┌───────────────┴───────────────┐
        ┌────────▼─────────┐            ┌─────────▼──────────┐
        │ TelegramAdapter  │            │ InstagramAdapter   │  (Later, §3.10)
        │ session/apiHash  │            │ ...                │
        │ peerId/accessHash│            └────────────────────┘
        │ GramJS вызовы    │
        └──────────────────┘
```

**Интерфейс адаптера (контракт имён, не реализация):**
```
PlatformAdapter {
  connect(account)            // → client        (сейчас: tgAuth.createClient)
  resolveTarget(raw)          // → Channel.tg    (сейчас: gramHelpers.resolvePeer)
  sendMessage / sendComment / react / readStories / fetchParticipants  // сейчас: gramHelpers/workers
  mapError(err)               // → унифицированный код (сейчас: protection.mapTelegramError)
}
```
Telegram-специфичные поля (`tg.*`, `.session`, `apiId/apiHash`) **не появляются** в Goal/Lead/Task.core.
Реализация выделения адаптера — Фаза 4; в Фазе 0 фиксируем только границу, чтобы новые поля клали по правильную сторону.

## Открытые вопросы (§6)
- 🔒 Роли Profile (Admin/Operator/Sales/Viewer) и матрица прав.
- 🔒 Формула `Channel.rating` и `Account.trustScore`; источник `region`.
- 🔒 Модель Proxy/SIM/device (поля `simId/deviceId/imei/rotationMin`).
- 🔒 Форматы/лимиты KnowledgeBase (OCR/vision).

_TODO(§6): помеченные 🔒 поля остаются как имена без выбранных значений/типов до решения бизнеса._
