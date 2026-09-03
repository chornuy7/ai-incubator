# CONTRACT · Локи аккаунтов и lease каналов

> Контракт Фазы 0 (Lane A). Источник истины кода — `server/lib/accountLocks.js` и
> `server/lib/channelLease.js` (оба покрыты юнит-тестами). ТЗ: §3.9, §4.

Два разных примитива взаимного исключения. **Лок** — на аккаунт, держится, пока жив
воркер. **Lease** — на канал, самоистекает по TTL. Оба хранятся в памяти процесса
(Map) и обнуляются при рестарте API (воркеры не переживают рестарт).

---

## 1. Лок аккаунта — «один аккаунт = одна задача»

Гарантия: в любой момент времени аккаунт занят максимум одной задачей на всех модулях.
Ключ — `accountId`, значение — `{ moduleKey, taskId, moduleLabel, since }`.

### API

- `tryAcquireLocks(accountIds, moduleKey, taskId, { force? }) → null | string`
  Атомарно (single-thread JS) проверяет конфликты и захватывает все `accountIds`.
  Возвращает `null` при успехе или человекочитаемую строку-ошибку с перечнем занятых
  аккаунтов. `force:true` захватывает поверх чужих локов (для force-разблокировки —
  должно порождать аудит `lock.forceRelease`).
- `releaseTaskLocks(taskId)` — снять все локи задачи (на завершении/остановке).
- `forceReleaseAccount(accountId) → lock | null` — ручное снятие «стухшего» лока.
- `assertAccountAvailable(accountId, taskId?)` — бросает `ACCOUNT_BUSY:<label>`,
  если аккаунт залочен другой задачей (guard на границе запуска).
- `getAccountLock(id)` / `getAllAccountLocks()` — чтение для UI.

### Живой реестр и самолечение

- `markTaskLive/markTaskDone/isTaskLive(taskId)` — реестр задач с реально крутящимся
  в этом процессе воркером.
- `reconcileLocks()` — снимает локи, чей `taskId` не «живой» **и** не имеет статуса
  `running`/`queued` на диске (задача завершена/удалена/устарела).
- `reconcileStaleTasksOnBoot()` — на старте API: очищает все локи, помечает
  «висящие» `running`/`queued` задачи как `stopped` (воркер не пережил рестарт) и
  **не** восстанавливает локи — иначе аккаунт остался бы «в работе» навсегда без воркера.

Приоритет прогрева (§3.9/§4) обеспечивается **до** захвата лока — на уровне статуса
(`canModuleUseAccount`, см. [state-machine](./CONTRACT-account-state-machine.md)):
`warming`-аккаунт не пройдёт guard других модулей.

---

## 2. Lease канала — «один канал в момент обновляет один бот» (§4)

Отличие от лока: lease **самоистекает по TTL**, поэтому зависший без `renew` бот
автоматически освобождает канал. Ключ — `channelId`, значение —
`{ botId, taskId, until }`. Все функции принимают `now` (тестируемость).

### API

- `acquireChannelLease(channelId, botId, taskId, ttlMs, now?) → null | conflict`
  Compare-and-set: если канал держит **другая** задача и lease не истёк —
  возвращает `{ code:'CHANNEL_LEASED', by, taskId, until }`; иначе захватывает/продлевает.
- `renewChannelLease(channelId, taskId, ttlMs, now?) → bool` — продлить свой lease
  (только владелец той же задачи).
- `releaseChannelLease(channelId, taskId?)` — без `taskId` снять безусловно; с `taskId`
  только если владелец совпал.
- `releaseTaskLeases(taskId)` — снять все лизы задачи.
- `getChannelLease(channelId, now?) → lease | null` — активный lease (null если истёк).
- `reconcileLeases(now?)` — снять протухшие (`until <= now`), вернуть снятые.

Используется оркестратором статистики каналов (`channelStats.js`): пара «канал–бот»
берётся под lease на время прохода, чтобы два бота не обновляли один канал параллельно.

---

## 3. Инварианты

1. Захват лока и lease атомарен относительно single-thread event loop — гонок в пределах
   процесса нет.
2. Оба примитива **эфемерны**: рестарт API = чистое состояние. Персистентность статусов
   задач — на диске (`taskStore`), не в локах.
3. Насильственное снятие лока (`force`/`forceReleaseAccount`) — событие аудита
   (`lock.forceRelease`, с инициатором).
