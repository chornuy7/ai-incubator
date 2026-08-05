# Реальные скриншоты модулей (MR-48, §9)

Сюда кладём НАСТОЯЩИЕ скриншоты экранов модулей — они заменяют
код-рисованный мок («Как это выглядит внутри») на странице «Обучение» и на
лендинге модуля.

## Как добавить

1. Открыть модуль в панели (например `/panel/modules/neuro-commenting`),
   сделать скриншот рабочего экрана (настройка: аккаунты + возможности + запуск).
2. Сохранить сюда как `<ключ-модуля>-1.png` (можно несколько: `-2.png`, `-3.png`).
3. Зарегистрировать в `src/pages/landing/ModuleShowcase.tsx` → `MODULE_SHOTS`:
   ```ts
   export const MODULE_SHOTS = {
     'neuro-commenting': ['/shots/neuro-commenting-1.png'],
   }
   ```
   (путь — публичный URL: файл `public/shots/x.png` доступен как `/shots/x.png`.)

Пока файла/записи нет — показывается мок в коде (ModuleMockScreen).

## Имена файлов по модулям

| Модуль | Ключ → файл |
|---|---|
| Нейрокомментинг | `neuro-commenting-1.png` |
| Нейрочаттинг | `neuro-chatting-1.png` |
| НейроДиалоги | `neuro-dialogs-1.png` |
| Массовые Реакции | `mass-react-1.png` |
| Масслукинг | `mass-looking-1.png` |
| Прогрев аккаунтов | `warming-1.png` |
| Автопостинг | `autoposting-1.png` |
| Мейлинг | `mailing-1.png` |
| AIR — AI Rating | `ggr-1.png` |
| Парсер каналов | `parsing-1.png` |
| Парсер групп | `parsing-groups-1.png` |
| Парсер пользователей | `parsing-users-1.png` |
| Парсер по сообщениям | `parsing-messages-1.png` |
| Парсер комментариев | `parsing-comments-1.png` |
