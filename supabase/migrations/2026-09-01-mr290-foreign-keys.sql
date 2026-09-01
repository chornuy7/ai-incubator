-- MR-290, шаг 2: связи внешними ключами вместо совпадения строк.
--
-- До этой миграции на 52 таблицы было 28 внешних ключей, из них 11 — один и тот же
-- «владелец записи». Всё остальное держалось на том, что код кладёт в text-колонку
-- правильную строку. Чем это кончается, видно по самим данным: в token_ledger пять
-- строк с пустым account_id (пустая строка вместо «нет аккаунта»), в module_actions два
-- действия с несуществующим модулем mass-reactions — ключа с таким именем в коде нет
-- вообще, это опечатка, прожившая в боевых данных с 17.08.
--
-- Здесь ставятся 33 недостающих ключа (28 → 61). Все проверены на живой базе: сирот нет, ни одна
-- строка не теряется. Два случая, где сироты были, чинятся ниже — правкой значения, а не
-- удалением записи.
--
-- ЧЕГО ЗДЕСЬ НЕТ и почему:
--   • Денежные таблицы (coin_balance, wallet_log.user_id, payments, token_ledger.user_id,
--     subscriptions, user_subscriptions.user_id). В колонке владельца там лежат не только
--     профили, но и служебные ключи __default («Системный кошелёк», balance.js:347) и
--     workspace (общая подписка). Это не мусор и не сироты — это понятия предметной
--     области, записанные строкой-меткой. Внешний ключ поверх них поставить нельзя, пока
--     «владелец» не разделён на «человек» и «платформа»: отдельный шаг задачи.
--   • user_subscriptions.module_key — там живёт метка «все модули, включая будущие»
--     (ALL_ROW в balance.js:173). Та же болезнь, тот же отдельный шаг.
--   • automation_rules.module_key — код пишет туда пустую строку (automation/store.js:126).
--     Ключ поставим, когда правило без модуля станет невозможным.
--
-- Все on delete выбраны осознанно, а не «как получится» — см. комментарии по группам.

-- ─────────────────────────────────────────────────────────────
-- 0. Две правки данных, без которых ключи не встают
-- ─────────────────────────────────────────────────────────────

-- Пустая строка — это не идентификатор. Пять строк журнала токенов записаны без аккаунта,
-- и «нет аккаунта» правильно выражается через NULL: колонка nullable, а пустая строка
-- проходит любую проверку на непустоту и потому опаснее.
update token_ledger set account_id = null where account_id = '';

-- mass-reactions — опечатка: модуль называется mass-react. Ключа mass-reactions нет ни в
-- справочнике modules, ни в коде (проверено поиском по server/ и src/). Строки не удаляем
-- — это журнал реальных действий, у него есть аккаунт, цель и время; чиним ключ.
update module_actions set module_key = 'mass-react' where module_key = 'mass-reactions';

-- ─────────────────────────────────────────────────────────────
-- 1. Индексы под будущие ключи
-- ─────────────────────────────────────────────────────────────
-- Внешний ключ без индекса на дочерней стороне — это полный проход по таблице при каждом
-- удалении родителя и медленный join. Postgres индекс сам не заводит: обязанность наша.
--
-- Заодно возвращаются два индекса из 2026-07-31-indexes.sql, которых на проде нет:
-- token_ledger_account_idx и token_ledger_task_idx. Миграция значится применённой, а
-- индексов нет — их когда-то сняли руками. Ровно тот случай, ради которого в шаге 1
-- появилась сверка npm run db:schema -- --check.
create index if not exists token_ledger_account_idx      on token_ledger (account_id);
create index if not exists token_ledger_task_idx         on token_ledger (task_id);
create index if not exists leads_account_idx             on leads (account_id);
create index if not exists leads_campaign_idx            on leads (campaign_id);
create index if not exists automation_rules_campaign_idx on automation_rules (campaign_id);
create index if not exists automation_rule_accounts_account_idx on automation_rule_accounts (account_id);
create index if not exists module_actions_goal_idx       on module_actions (goal_id);
create index if not exists module_actions_module_idx     on module_actions (module_key);
create index if not exists knowledge_base_file_idx       on knowledge_base (file_ref);
create index if not exists setup_modules_module_idx      on setup_modules (module_key);
create index if not exists user_prompts_module_idx       on user_prompts (module_key);
create index if not exists user_gifts_module_idx         on user_gifts (module_key);
create index if not exists module_presets_author_idx     on module_presets (author_id);

-- ─────────────────────────────────────────────────────────────
-- 2. Ссылки на аккаунт (accounts_meta)
-- ─────────────────────────────────────────────────────────────
-- Два разных смысла — два разных поведения при удалении аккаунта:
--
--   CASCADE — производные данные: усталость, дневные счётчики, доверие, состав правила
--   автоматизации. Без аккаунта они бессмысленны и никого не интересуют.
--
--   RESTRICT — журналы и переписка. Удалить аккаунт, за перепиской которого мы отвечаем
--   (см. комментарий к таблице messages: «внутри нашей экосистемы чужие люди работают
--   нашими Telegram-аккаунтами, и за то, что они пишут, отвечаем мы»), молча нельзя.
--   Сегодня это ничего не ломает: deleteAccountMeta чистит только JSON-файл и до строки
--   в базе вообще не доходит — то есть аккаунты из БД сейчас не удаляются никогда.
--   Когда удаление починят, RESTRICT заставит решить судьбу архива явно, а не потерять
--   его вместе со строкой.
alter table account_activity         add constraint account_activity_account_fkey         foreign key (account_id) references accounts_meta(id) on delete cascade;
alter table daily_actions            add constraint daily_actions_account_fkey            foreign key (account_id) references accounts_meta(id) on delete cascade;
alter table trust_cache              add constraint trust_cache_account_fkey              foreign key (account_id) references accounts_meta(id) on delete cascade;
alter table automation_rule_accounts add constraint automation_rule_accounts_account_fkey foreign key (account_id) references accounts_meta(id) on delete cascade;

alter table messages       add constraint messages_account_fkey       foreign key (account_id) references accounts_meta(id) on delete restrict;
alter table token_ledger   add constraint token_ledger_account_fkey   foreign key (account_id) references accounts_meta(id) on delete restrict;
alter table module_actions add constraint module_actions_account_fkey foreign key (account_id) references accounts_meta(id) on delete restrict;
alter table leads          add constraint leads_account_fkey          foreign key (account_id) references accounts_meta(id) on delete restrict;

-- ─────────────────────────────────────────────────────────────
-- 3. Ссылки на кампанию и цель
-- ─────────────────────────────────────────────────────────────
-- Кампанию и цель удаляют как рабочие сущности, а лиды, ссылки и журнал действий должны
-- это пережить: SET NULL. Исключение — база знаний: она заводится ВНУТРИ цели и вне её
-- не имеет смысла, поэтому CASCADE.
alter table leads            add constraint leads_campaign_fkey            foreign key (campaign_id) references campaigns(id) on delete set null;
alter table automation_rules add constraint automation_rules_campaign_fkey foreign key (campaign_id) references campaigns(id) on delete set null;

alter table knowledge_base add constraint knowledge_base_goal_fkey foreign key (goal_id) references goals(id) on delete cascade;
alter table tracked_links  add constraint tracked_links_goal_fkey  foreign key (goal_id) references goals(id) on delete set null;
alter table module_actions add constraint module_actions_goal_fkey foreign key (goal_id) references goals(id) on delete set null;

-- Вложение базы знаний. В миграции 27.08 стоял комментарий «НЕ внешний ключ намеренно:
-- удаление файла не должно уносить саму запись» — но это описание не отсутствия ключа, а
-- ключа с ON DELETE SET NULL. Ставим именно его: запись остаётся, ссылка обнуляется, а
-- висячих ссылок на несуществующий файл больше не бывает.
alter table knowledge_base add constraint knowledge_base_file_fkey foreign key (file_ref) references kb_files(id) on delete set null;

-- ─────────────────────────────────────────────────────────────
-- 4. Ссылки на справочник модулей
-- ─────────────────────────────────────────────────────────────
-- RESTRICT везде: справочник наполняется из кода (lib/typesSync.js — только upsert, без
-- удалений), поэтому запрет на удаление модуля, за который кто-то заплатил или которым
-- что-то настроено, — именно то, что нужно. CASCADE тут означал бы «выкатили релиз без
-- модуля — и у клиентов молча пропали подписки».
alter table setup_modules  add constraint setup_modules_module_fkey  foreign key (module_key) references modules(key) on delete restrict;
alter table user_prompts   add constraint user_prompts_module_fkey   foreign key (module_key) references modules(key) on delete restrict;
alter table user_gifts     add constraint user_gifts_module_fkey     foreign key (module_key) references modules(key) on delete restrict;
alter table module_presets add constraint module_presets_module_fkey foreign key (module_key) references modules(key) on delete restrict;
alter table module_actions add constraint module_actions_module_fkey foreign key (module_key) references modules(key) on delete restrict;

-- ─────────────────────────────────────────────────────────────
-- 5. Ссылки на владельца-человека (profiles.legacy_id)
-- ─────────────────────────────────────────────────────────────
-- Цель — profiles(legacy_id), как у одиннадцати уже существующих ключей: колонка
-- уникальна, значения в дочерних таблицах того же вида, и переезд не требует ни одной
-- правки данных. Перевод всей базы на profiles(id) uuid — отдельный шаг задачи; смешивать
-- его с расстановкой ключей значило бы менять две вещи разом и не понять, что сломалось.
--
--   CASCADE — личные настройки: удалили человека, ушли и его промпты, подарки, ИИ-настройки.
--   RESTRICT — то, что переживает человека: обращения в поддержку и учёт рабочего времени.
--     Смена оператора — основание для расчёта; молча стирать её при удалении профиля нельзя.
--   SET NULL — «кто завёл» у общих объектов: шаблоны, папки, ссылки, агенты, сохранённые
--     запросы парсера. Объект остаётся, автор теряется — это допустимо, потеря объекта нет.
alter table user_prompts     add constraint user_prompts_owner_fkey     foreign key (user_id) references profiles(legacy_id) on delete cascade;
alter table user_gifts       add constraint user_gifts_owner_fkey       foreign key (user_id) references profiles(legacy_id) on delete cascade;
alter table user_ai_settings add constraint user_ai_settings_owner_fkey foreign key (user_id) references profiles(legacy_id) on delete cascade;

alter table tickets  add constraint tickets_owner_fkey  foreign key (user_id) references profiles(legacy_id) on delete restrict;
alter table work_log add constraint work_log_owner_fkey foreign key (user_id) references profiles(legacy_id) on delete restrict;

alter table tickets          add constraint tickets_to_owner_fkey       foreign key (to_owner_id) references profiles(legacy_id) on delete set null;
alter table module_presets   add constraint module_presets_owner_fkey   foreign key (user_id)     references profiles(legacy_id) on delete set null;
alter table module_presets   add constraint module_presets_author_fkey  foreign key (author_id)   references profiles(legacy_id) on delete set null;
alter table automation_rules add constraint automation_rules_owner_fkey foreign key (user_id)     references profiles(legacy_id) on delete set null;
alter table target_folders   add constraint target_folders_owner_fkey   foreign key (user_id)     references profiles(legacy_id) on delete set null;
alter table tracked_links    add constraint tracked_links_owner_fkey    foreign key (user_id)     references profiles(legacy_id) on delete set null;
alter table parser_cache     add constraint parser_cache_owner_fkey     foreign key (owner_id)    references profiles(legacy_id) on delete set null;
alter table agents           add constraint agents_owner_fkey           foreign key (user_id)     references profiles(legacy_id) on delete set null;
alter table wallet_log       add constraint wallet_log_actor_fkey       foreign key (actor_id)    references profiles(legacy_id) on delete set null;

comment on column token_ledger.account_id is
  'Аккаунт, за который списаны токены. NULL — списание не привязано к аккаунту. Пустой строки здесь больше не бывает: MR-290 перевёл её в NULL.';
