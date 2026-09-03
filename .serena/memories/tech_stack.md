# Стек

`"type": "module"` в `package.json` — **весь проект ESM**, включая `server/`. CommonJS-паттерны
(`require`, `__dirname`) не работают без переходников.

## Фронт

- React 18.3, TypeScript 5.6, Vite 5.4
- `zustand` 5 — состояние (не Redux, не Context-обвязка)
- `react-router-dom` 6
- Tailwind 3.4 + PostCSS; `lucide-react` — иконки; `clsx` — классы
- Сборка `npm run build` = `tsc --noEmit && vite build`

## Бэкенд

- Node + Express 4.21, запускается напрямую: `node server/index.js`, сборки нет
- **`telegram` 2.26 (GramJS)** — сессии Telegram; `@mtcute/convert` — конвертация форматов сессий
- `@supabase/supabase-js` 2.110 + `pg` 8.23 — Postgres/Supabase
- `sql.js` — кеш парсера (`server/data/parser-cache.db`)
- `cheerio` — парсинг HTML; `exceljs` — выгрузки; `multer` — загрузка файлов;
  `socks` — прокси; `dotenv` — окружение

## Чего нет

- **Линтера нет.** `npm run lint` — это `tsc --noEmit`, не ESLint. Не искать конфиг линтера.
- Сборки бэкенда нет; транспиляции серверного кода нет.
- Тест-раннера-фреймворка нет: `node --test`, встроенный.

Версии пинов смотреть в `package.json` — здесь только те, где мажор влияет на выбор API.
