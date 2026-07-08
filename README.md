# AI Incubator — мок-панель управления Telegram-автоматизацией

> **Текущий шаг:** авторизация аккаунтов + менеджер — см. [`../docs/TZ-STEP-1-ACCOUNTS.md`](../docs/TZ-STEP-1-ACCOUNTS.md)

Полностью отрисованный фронтенд «комбайна» для управления Telegram-аккаунтами и модулями
автоматизации (нейрокомментинг, нейрочаттинг, масс-реакции, масслукинг, прогрев, нейродиалоги,
GGR-рейтинг, парсеры). **Всё на мок-данных** — ничего не отправляется на сервер, реального API нет.
Новый тёмный «инкубаторный» дизайн (neon emerald/lime `spark` + violet `iris`), собственная дизайн-система.

## Запуск

```bash
cd ai-incubator
npm install
npm run dev      # http://localhost:5173
npm run build    # прод-сборка (tsc + vite)
npm run preview  # предпросмотр сборки
```

## Сценарии данных

Переключаются в **Dev-панели** (кнопка «Dev» внизу слева) или через query-параметр `?mockState=`:

| Сценарий | URL | Что показывает |
|----------|-----|----------------|
| С данными | `?mockState=with-data` | 10 аккаунтов, 80 ⚡, заполненные таблицы/логи/история |
| Пустой | `?mockState=empty` | 0 аккаунтов, 31 ⚡, empty-state везде |
| Без подписки | `?mockState=no-sub` | Paywall-баннер + заблокированные модули (blur + CTA) |
| Гость | `?mockState=guest` | Экран входа |

Состояние (сценарий, тема, язык, тумблер ошибок, все изменения данных) **сохраняется в `localStorage`**
и переживает перезагрузку. «Сбросить данные» в Dev-панели возвращает сценарий к исходному сиду.

## Экраны (17 маршрутов)

- `/panel` — Менеджер аккаунтов: 7 статус-карточек (фильтр), табы Аккаунты/Корзина, поиск, фильтры
  (роль/страна), колонки, обновление (skeleton), чекбоксы + массовые действия, контекст-меню строки
  (Детали / Реавторизация / Сменить прокси / В корзину), пагинация, пул прокси, импорт, мастер добавления.
- `/panel/my-statistics` — периоды, экспорт (CSV Blob), вкладки Дашборд/Аккаунты/История, KPI, столбчатый график, ленты истории.
- `/panel/support` — тикеты, фильтр статуса, новый тикет, просмотр переписки.
- `/panel/modules/*` (004–015) — единый data-driven движок `ModuleRunner` + конфиг `shared/config/modules.ts`.
- `/panel/parsing-history` — фильтры (дата/модуль/статус), таблица, детали, экспорт.
- `/panel/user/profile` — подвкладки Профиль/Аккаунт/Безопасность/Уведомления/Партнёрка/API.

## Запуск

```bash
cd ai-incubator
npm install
npm run dev      # фронт :5173 + TG API :3001
```

Нужны **TELEGRAM_API_ID** и **TELEGRAM_API_HASH** в `.env` (см. `.env.example`).

## Авторизация аккаунтов (реальная)

Через **MTProto / GramJS** на локальном API-сервере (`server/`):

1. «Добавить аккаунт» → номер + прокси → **реальный SMS или код в Telegram**
2. Если включена 2FA → облачный пароль
3. Сессия сохраняется в `server/data/sessions/`, в таблице — имя и @username с Telegram

Прокси обязателен (`socks5://user:pass@host:port`).
- **Запуск модуля** → выбор аккаунтов/источников/настроек → «Начать» → мок-задача (виден в Drawer «Задачи») + toast.
- **Мок-ошибки сети** — тумблер в Dev-панели: действия падают в toast-ошибку.

## Стек

React 18 · Vite · TypeScript · Tailwind CSS · Zustand · React Router 6 · lucide-react.
Интерфейс — только русский (переключатель языков присутствует, но интерфейс остаётся на русском).

## Структура

```
src/
├── app/Layout.tsx          # shell (sidebar + header + drawers)
├── pages/                  # 17 экранов + Guest
├── widgets/                # AppHeader, AppSidebar, LogsPanel, TasksDrawer, DevPanel, Toasts
├── features/               # add-tg-account, import-sessions, account-picker, proxy, paywall
├── shared/
│   ├── ui/                 # UI-кит (Modal, Select, Segmented, Switch, BarChart, …)
│   ├── config/             # routes.ts, modules.ts (★ расширять для новых контролов модулей)
│   ├── lib/                # utils, hooks, uiStore
│   └── types.ts            # доменная модель
└── mocks/                  # store (Zustand + localStorage), seeds, tgApi, logs, parseResults
```

Фаза 2 (позже): заменить `src/mocks/` на реальный `api/` без правок UI.
