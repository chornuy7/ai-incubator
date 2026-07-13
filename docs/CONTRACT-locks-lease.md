# Контракт: блокировки (lock) и аренда (lease)

> **Фаза 0 · Lane A.** Требования: [TZ-2026-07-10.md](./TZ-2026-07-10.md) §3.9, §4.
> Расширяет [`server/lib/accountLocks.js`](../server/lib/accountLocks.js) — **не переписывает**.
> Два разных примитива: **lock** (аккаунт↔задача) уже есть; **lease** (канал↔бот) — новый.

## 1. Два примитива

| | **Lock аккаунта** | **Lease канала** |
|---|---|---|
| Правило ТЗ | «Один аккаунт = одна задача» (§3.9) | «Один канал — один бот в моменте» (§3.9, §4) |
| Что защищает | аккаунт от параллельного захвата двумя задачами | канал от одновременного обновления статистики двумя ботами |
| Ключ | `accountId` | `channelId` |
| Значение | `{ moduleKey, taskId, since }` | `{ channelId, botId(accountId), taskId, ttl, since }` |
| Живёт | в памяти процесса (`Map`) | в памяти процесса (`Map`), с TTL |
| Статус | ✅ реализован | ☐ новый (Фаза 2/3) |

## 2. Lock аккаунта — текущий контракт (сохраняем)

Уже реализовано в `accountLocks.js`, менять сигнатуры **нельзя** без согласования:

```
tryAcquireLocks(accountIds, moduleKey, taskId, { force? }) → null | errorMessage
releaseTaskLocks(taskId)
getAccountLock(accountId) / getAllAccountLocks()
assertAccountAvailable(accountId, taskId?)          // throws ACCOUNT_BUSY:<label>
forceReleaseAccount(accountId)                      // ручное снятие стухшего лока
markTaskLive / markTaskDone / isTaskLive            // живой реестр воркеров
reconcileLocks()                                    // самолечение стухших локов
reconcileStaleTasksOnBoot()                         // на старте: running→stopped, локи не восстанавливаем
```

**Инварианты (существующие, не ломать):**
1. Захват атомарен по набору: при конфликте хотя бы одного аккаунта (без `force`) — не берём **ни одного**.
2. Идемпотентность по `taskId`: повторный захват своей же задачей не конфликтует.
3. Локи не переживают рестарт: воркеры в памяти → на старте `reconcileStaleTasksOnBoot` чистит.

## 3. Расширения lock (Фаза 1–2, §3.3/§3.9)

Добавляем **поверх** существующего API, обратносовместимо:

- **Приоритет прогрева (§3.3, §4):** аккаунт в статусе `warming` не лочится рабочими модулями.
  Проверка добавляется в `tryAcquireLocks` (консультируется со `status`, см. state machine).
  Прогрев может **вытеснить** рабочую задачу (авто-возврат в прогрев при падении trust — 🔒 §6).
- **Запрет конфликтующих задач (§3.9):** один аккаунт не в двух активных задачах — уже гарантирует lock;
  контракт лишь фиксирует, что проверка «конфликтующих» = наличие любого чужого lock.
- **Причина отказа наружу:** текст ошибки остаётся человекочитаемым (сейчас так), плюс машинный код
  `ACCOUNT_BUSY` / `ACCOUNT_WARMING` для UI-подтверждений (§3.2).

```
// расширенная форма (предложение, реализация — Lane A):
tryAcquireLocks(accountIds, moduleKey, taskId, {
  force?: boolean,
  respectStatus?: boolean,   // true → отказ, если аккаунт warming/pause/floodwait/…
  reason?: string            // для аудита переноса (§4)
}) → null | { code: 'ACCOUNT_BUSY'|'ACCOUNT_WARMING'|'ACCOUNT_STATUS', message, conflicts[] }
```

## 4. Lease канала — новый контракт (§3.9)

Для модуля статистики каналов: «уникальные пары один канал — один доступный бот», защита от гонки в миллисекундах.

```
acquireChannelLease(channelId, botId, taskId, ttlMs) → null | { code:'CHANNEL_LEASED', by, until }
renewChannelLease(channelId, taskId, ttlMs)          → bool
releaseChannelLease(channelId, taskId)
getChannelLease(channelId)                            → { botId, taskId, until } | null
reconcileLeases()                                     // снять протухшие (now > until)
```

**Инварианты lease:**
1. В момент времени у канала ≤ 1 активный lease (`now < until`).
2. Захват атомарен (compare-and-set в `Map`), устойчив к гонке в миллисекундах (§3.9).
3. Lease **самоистекает** по `ttl` (в отличие от lock) — бот, зависший без renew, освобождает канал.
4. Порядок обхода (§3.9): **первый проход** — боты, уже работающие в канале; **второй** — назначить
   свободных ботов на необслуженные каналы. Реализует оркестратор статистики, lease — примитив под это.

## 5. Взаимодействие lock ↔ lease ↔ status

```
Task статистики каналов:
  1) tryAcquireLocks(bots, 'stats', taskId, {respectStatus:true})   // аккаунты свободны и рабочие
  2) для каждой пары (channel, bot): acquireChannelLease(channel, bot, taskId, ttl)
  3) renewChannelLease по ходу; releaseChannelLease по завершении канала
  4) releaseTaskLocks(taskId) в конце
```

- Нельзя взять lease каналом на бота, у которого нет lock этой же задачи (проверка на уровне оркестратора).
- Смена статуса аккаунта на нерабочий (`floodwait/quarantine/…`) обязана освободить его локи **и** лизы
  (см. инвариант 5 в [CONTRACT-account-state-machine.md](./CONTRACT-account-state-machine.md)).

## 6. Аудит (§4)

Каждый `force`-захват, `forceReleaseAccount`, перенос между модулями и вытеснение прогревом — пишут
запись в единый лог с инициатором (см. [CONTRACT-audit-log.md](./CONTRACT-audit-log.md), `action: lock.*`).

## Открытые вопросы (§6)
- 🔒 Может ли прогрев **вытеснять** уже запущенную рабочую задачу или только не даёт стартовать новую (зависит от политики trust — §6).
- 🔒 Значение TTL lease по умолчанию (связано с периодом обновления статистики — §6).

_TODO(§6): дефолтный `ttlMs` и политика вытеснения — после решения бизнеса._
