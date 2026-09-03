-- MR-38 (§6): КЭШ РЕЗУЛЬТАТОВ ПАРСИНГА переезжает из локального SQLite в общую БД.
--
-- Зачем переезд. Кэш лежал файлом `server/data/parser-cache.db` на диске одной машины:
-- при втором инстансе или переезде в контейнер у каждого сервера был бы свой кэш —
-- один клиент видит «из базы от 12:00», другой не видит ничего. Плюс это был третий
-- шаблон хранения: у всех остальных сторов есть переключатель «есть Supabase — туда,
-- нет — в файлы», а здесь всегда SQLite. Теперь кэш там же, где остальные данные.
--
-- Ключ — sha256 от сигнатуры запроса, а не сама сигнатура: у парсера бывает полсотни
-- ключевых слов, и сырой JSON не влезает в btree-индекс Postgres (лимит ~2.7 КБ).
-- Человекочитаемая подпись запроса остаётся в `keywords` — для глазами посмотреть.
--
-- Данные публичные (те же каналы, что и в общей базе §3.8), поэтому кэш общий на
-- платформу, а не пер-юзерный: один и тот же поиск не должен парситься дважды.

create table if not exists parser_cache (
  sig        text primary key,                      -- sha256(сигнатура запроса)
  kind       text not null default '',              -- модуль: parsing / parsing-groups / parsing-users / …
  keywords   text not null default '',              -- подпись запроса словами (для чтения человеком)
  updated_at bigint not null,                       -- когда собрали (мс), её показывает витрина
  count      integer not null default 0,
  results    jsonb not null default '[]'::jsonb
);

create index if not exists parser_cache_updated_idx on parser_cache (updated_at desc);
create index if not exists parser_cache_kind_idx    on parser_cache (kind);

-- Таблица служебная: в неё ходит только бэкенд сервисным ключом (он обходит RLS).
-- Политик намеренно нет — значит для anon/authenticated доступа не будет.
alter table parser_cache enable row level security;

comment on table parser_cache is 'MR-38 (§6): кэш результатов парсинга. Ключ — sha256 сигнатуры запроса (тип модуля + ключевые слова/источники + фильтры). Повтор того же поиска отдаётся отсюда с датой последнего обновления, без нового прохода по аккаунтам.';
