-- MR-38 (продолжение): СЛЕЖЕНИЕ ЗА ЗАПРОСОМ ПАРСИНГА.
--
-- Запрос владельца 24.08: «весь парсинг чтобы работал и сохранял, потом проходился по
-- ним и перепроверял актуальность и новые каналы по тем же ключевым словам — какая-то
-- крона раз в 24 часа; если новый запрос — новая строка в БД; ошибки видно в админке».
--
-- Кэш (2026-08-24-parser-cache.sql) уже хранит РЕЗУЛЬТАТ под сигнатуру запроса. Чтобы
-- запрос можно было ПЕРЕЗАПУСТИТЬ через сутки, нужно хранить и сам запрос — настройки
-- парсинга целиком, иначе от сигнатуры-хэша обратной дороги нет.
--
-- Слежение ВЫКЛЮЧЕНО по умолчанию и включается на конкретный запрос. Причина простая:
-- перепроверка — это реальный проход по аккаунтам и списание монет владельца. Включать
-- такое молча за человека нельзя: он не нажимал, а деньги ушли бы.

alter table parser_cache add column if not exists owner_id    text;         -- чей запрос: под его аккаунтами и его балансом пойдёт перепроверка
alter table parser_cache add column if not exists settings    jsonb;        -- сам запрос целиком — чтобы было что перезапускать
alter table parser_cache add column if not exists watch       boolean not null default false;
alter table parser_cache add column if not exists period_h    integer not null default 24;  -- как часто перепроверять, часов
alter table parser_cache add column if not exists next_run_at bigint;       -- когда пора (мс)
alter table parser_cache add column if not exists last_run_at bigint;       -- когда проверяли в последний раз
alter table parser_cache add column if not exists last_new    integer not null default 0;   -- сколько НОВЫХ нашли в прошлый заход
alter table parser_cache add column if not exists last_gone   integer not null default 0;   -- сколько пропало (канал удалён/закрыт)
alter table parser_cache add column if not exists last_error  text;         -- почему не вышло — это и показываем в админке
alter table parser_cache add column if not exists fail_count  integer not null default 0;   -- подряд неудач: после нескольких слежение само встаёт

-- Планировщик выбирает «созревшие» — по этому индексу и ходит.
create index if not exists parser_cache_watch_idx on parser_cache (watch, next_run_at) where watch;
-- Админке нужен список сломанных запросов.
create index if not exists parser_cache_error_idx on parser_cache (last_error) where last_error is not null;
create index if not exists parser_cache_owner_idx on parser_cache (owner_id);

comment on column parser_cache.settings is 'Запрос целиком (ключевые слова/источники/фильтры) — чтобы перепроверка могла его перезапустить: от sha256-сигнатуры обратной дороги нет.';
comment on column parser_cache.watch    is 'Следить за запросом: раз в period_h часов перезапускать парс, искать новые каналы и отмечать пропавшие. Выключено по умолчанию — перепроверка тратит аккаунты и монеты владельца.';
