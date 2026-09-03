-- СНИМОК СХЕМЫ БАЗЫ. ФАЙЛ СГЕНЕРИРОВАН — РУКАМИ НЕ ПРАВИТЬ.
--
-- Собирается из каталогов самой базы: npm run db:schema (server/scripts/schema-dump.mjs).
-- Формат — server/scripts/schema-dump.sql. Сверка расхождений — npm run db:schema -- --check.
--
-- Это СПРАВКА И ЭТАЛОН ДЛЯ СВЕРКИ, а не способ применения. Схему меняют миграции из
-- supabase/migrations (npm run migrate); снимок пересобирается после них и едет тем же PR.
-- Прежний рукописный schema.sql описывал 14 таблиц из 52 и содержал давно удалённую
-- parsed_channels: расхождение замечали по странным ошибкам, а не по файлу (MR-290).

-- ─── ТАБЛИЦЫ ───

create table account_activity (
  account_id text not null,
  fatigue numeric(10,2) default 0 not null,
  rest_until bigint default 0 not null,
  last_action_at bigint default 0 not null,
  actions_total integer default 0 not null,
  data jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table account_groups (
  id text not null,
  name text default ''::text not null,
  account_ids jsonb default '[]'::jsonb not null,
  color text default ''::text not null,
  note text default ''::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  user_id text
);

create table accounts_meta (
  id text not null,
  name text,
  username text,
  phone text,
  status text,
  proxy text,
  country text,
  in_trash boolean default false not null,
  data jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null,
  user_id text
);

create table agents (
  id text not null,
  name text default ''::text not null,
  data jsonb default '{}'::jsonb not null,
  user_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table app_settings (
  key text not null,
  value jsonb default '{}'::jsonb not null,
  updated_at timestamp with time zone default now() not null
);

create table audit_log (
  id text,
  ts timestamp with time zone default now() not null,
  action text,
  module text,
  initiator text,
  code text,
  reason text,
  scope jsonb default '{}'::jsonb not null,
  account text,
  meta jsonb
);

create table automation_rule_accounts (
  rule_id text not null,
  account_id text not null,
  position integer default 0 not null
);

create table automation_rules (
  id text not null,
  user_id text,
  name text not null,
  enabled boolean default true not null,
  module_key text default ''::text not null,
  campaign_id text,
  settings jsonb default '{}'::jsonb not null,
  schedule_type text default 'interval'::text not null,
  schedule_at bigint,
  schedule_interval_minutes integer,
  schedule_time text,
  last_run bigint,
  last_status text,
  last_task_id text,
  next_run bigint,
  created_at bigint not null,
  updated_at bigint not null
);

create table bundle_modules (
  bundle_id text not null,
  module_id bigint not null
);

create table bundles (
  id text not null,
  name text not null,
  hint text default ''::text not null,
  price numeric(12,2) not null,
  created_at timestamp with time zone default now() not null
);

create table campaign_modules (
  campaign_id text not null,
  module_id bigint not null
);

create table campaign_schedules (
  id text not null,
  name text default ''::text not null,
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  user_id text
);

create table campaigns (
  id text not null,
  name text not null,
  goal_id text,
  modules text[] default '{}'::text[] not null,
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  user_id text
);

create table channels (
  id text not null,
  title text default ''::text not null,
  username text default ''::text not null,
  link text default ''::text not null,
  subscribers integer default 0 not null,
  has_comments boolean default false not null,
  tg_peer_id text default ''::text not null,
  rating numeric(6,2),
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  user_id text
);

create table coin_balance (
  user_id text not null,
  coins numeric(14,3) default 0 not null,
  updated_at timestamp with time zone default now() not null,
  usd numeric(14,2) default 0 not null
);

create table daily_actions (
  account_id text not null,
  day text not null,
  action text not null,
  count integer default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table goals (
  id text not null,
  name text not null,
  data jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  user_id text
);

create table kb_files (
  id text not null,
  name text not null,
  mime text not null,
  size_bytes integer not null,
  data bytea not null,
  created_at bigint not null
);

create table knowledge_base (
  id text not null,
  goal_id text not null,
  kind text default 'text'::text not null,
  title text default ''::text not null,
  content text default ''::text not null,
  file_ref text,
  url text,
  scope text default 'all'::text not null,
  version integer default 1 not null,
  created_at bigint not null,
  updated_at bigint not null
);

create table leads (
  id text not null,
  goal_id text,
  account_id text,
  peer text,
  status text default 'cold'::text not null,
  is_hot boolean default false not null,
  result text default ''::text,
  note text default ''::text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  campaign_id text,
  followups integer default 0 not null,
  user_id text,
  task_id text
);

create table link_hits (
  id text not null,
  code text not null,
  fp text not null,
  ref text default ''::text not null,
  ts bigint not null
);

create table messages (
  id bigint default nextval('messages_id_seq'::regclass) not null,
  account_id text not null,
  user_id text,
  peer text default ''::text not null,
  direction text not null,
  text text default ''::text not null,
  module_key text default ''::text not null,
  task_id text default ''::text not null,
  campaign_id text default ''::text not null,
  created_at timestamp with time zone default now() not null
);

create table model_prices (
  model text not null,
  input_per_1m numeric default 0 not null,
  output_per_1m numeric default 0 not null,
  updated_at timestamp with time zone default now() not null
);

create table module_actions (
  id text not null,
  ts timestamp with time zone default now() not null,
  type text not null,
  status text default 'sent'::text not null,
  account_id text,
  account_name text,
  target text,
  target_title text,
  object_ref jsonb default '{}'::jsonb not null,
  value jsonb default '{}'::jsonb not null,
  module_key text,
  task_id text,
  launch_id text,
  goal_id text,
  initiator text,
  audience jsonb default '{}'::jsonb not null,
  meta jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);

create table module_presets (
  id text not null,
  module_key text not null,
  user_id text,
  name text not null,
  color text,
  owner_label text,
  settings jsonb default '{}'::jsonb not null,
  created_at bigint not null,
  author_id text
);

create table module_prices (
  module_id bigint not null,
  month_price numeric(12,2) default 0 not null,
  action_price numeric(12,4) default 0 not null,
  updated_at timestamp with time zone default now() not null,
  month_tokens integer default 100 not null
);

create table modules (
  id bigint default nextval('modules_id_seq'::regclass) not null,
  key text not null,
  title text default ''::text not null
);

create table parser_cache (
  sig text not null,
  kind text default ''::text not null,
  keywords text default ''::text not null,
  updated_at bigint not null,
  count integer default 0 not null,
  results jsonb default '[]'::jsonb not null,
  owner_id text,
  settings jsonb,
  watch boolean default false not null,
  period_h integer default 24 not null,
  next_run_at bigint,
  last_run_at bigint,
  last_new integer default 0 not null,
  last_gone integer default 0 not null,
  last_error text,
  fail_count integer default 0 not null,
  title text
);

create table payments (
  id text not null,
  ts bigint not null,
  user_id text,
  kind text,
  coins numeric,
  amount_fiat numeric,
  currency text,
  modules integer,
  status text,
  reason text
);

create table price_overrides (
  id text default 'default'::text not null,
  modules jsonb default '{}'::jsonb not null,
  annual_discount numeric,
  coins_per_1k_tokens numeric,
  token_usd numeric,
  image_multiplier numeric,
  coin_packs jsonb,
  updated_at timestamp with time zone default now() not null,
  periods jsonb,
  input_share numeric,
  max_input_chars integer,
  max_output_chars integer,
  chars_per_token numeric,
  vision_input_tokens integer,
  vision_output_tokens integer
);

create table profiles (
  id uuid not null,
  legacy_id text,
  name text default ''::text not null,
  active boolean default true not null,
  parent_id uuid,
  user_type_id bigint,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  role_ids text[] default '{}'::text[] not null,
  account_ids text[] default '{}'::text[] not null,
  account_group_ids text[] default '{}'::text[] not null,
  balance_mode text default 'shared'::text not null,
  token_limit numeric,
  tokens_valid_from timestamp with time zone
);

create table roles (
  id text not null,
  name text not null,
  permissions jsonb default '{}'::jsonb not null,
  builtin boolean default false not null,
  created_at timestamp with time zone default now() not null,
  user_id text
);

create table schema_migrations (
  name text not null,
  checksum text not null,
  applied_at timestamp with time zone default now() not null
);

create table setup_modules (
  setup_id text not null,
  module_key text not null
);

create table setups (
  id text not null,
  name text not null,
  hint text default ''::text not null,
  discount numeric default 0 not null,
  all_modules boolean default false not null,
  sort integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table subscriptions (
  id text not null,
  scope text not null,
  user_id text,
  expires_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null,
  billing_day smallint,
  last_credit_month text,
  last_charge_month text,
  last_credit_at timestamp with time zone,
  canceled_at timestamp with time zone
);

create table target_folder_targets (
  folder_id text not null,
  username text not null,
  position integer default 0 not null
);

create table target_folders (
  id text not null,
  user_id text,
  name text not null,
  created_at bigint not null,
  updated_at bigint not null
);

create table ticket_messages (
  id text not null,
  ticket_id text not null,
  side text not null,
  author_id text,
  author_name text,
  author_email text,
  text text not null,
  ts bigint not null
);

create table tickets (
  id text not null,
  user_id text not null,
  subject text not null,
  category text default 'tech'::text not null,
  status text default 'open'::text not null,
  created_at bigint not null,
  updated_at bigint not null,
  read_user bigint default 0 not null,
  read_support bigint default 0 not null,
  to_owner_id text
);

create table token_ledger (
  id bigint generated always as identity not null,
  ts timestamp with time zone default now() not null,
  user_id text,
  module text,
  account_id text,
  task_id text,
  campaign_id text,
  model text,
  tokens integer default 0 not null,
  prompt_tokens integer default 0 not null,
  completion_tokens integer default 0 not null,
  coins numeric(14,3) default 0 not null
);

create table tracked_links (
  id text not null,
  code text not null,
  user_id text,
  url text not null,
  title text default ''::text not null,
  goal_id text,
  campaign_id text,
  hits integer default 0 not null,
  unique_hits integer default 0 not null,
  created_at bigint not null
);

create table trust_cache (
  account_id text not null,
  score integer not null,
  band text,
  updated_at bigint not null
);

create table user_ai_settings (
  user_id text not null,
  global_prompt text default ''::text not null,
  updated_at timestamp with time zone default now() not null
);

create table user_gifts (
  id bigint default nextval('user_gifts_id_seq'::regclass) not null,
  user_id text not null,
  module_key text not null,
  coins integer not null,
  credited_at timestamp with time zone default now() not null
);

create table user_prompts (
  id bigint default nextval('user_prompts_id_seq'::regclass) not null,
  user_id text not null,
  module_key text not null,
  idx integer not null,
  body text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table user_subscriptions (
  id bigint default nextval('user_subscriptions_id_seq'::regclass) not null,
  user_id text not null,
  module_key text not null,
  started_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);

create table user_type_modules (
  user_type_id bigint not null,
  module_id bigint not null
);

create table user_types (
  id bigint default nextval('user_types_id_seq'::regclass) not null,
  name text not null,
  title text default ''::text not null,
  created_at timestamp with time zone default now() not null
);

create table users (
  id text not null,
  email text not null,
  name text default ''::text not null,
  password_hash text,
  role_ids text[] default '{}'::text[] not null,
  active boolean default true not null,
  parent_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  user_type_id bigint
);

create table wallet_log (
  id bigint generated always as identity not null,
  ts timestamp with time zone default now() not null,
  user_id text,
  amount numeric(14,3) not null,
  before_val numeric(14,3),
  after_val numeric(14,3),
  reason text,
  currency text default 'coins'::text not null,
  kind text,
  actor_id text,
  modules text[]
);

create table work_log (
  id text not null,
  user_id text not null,
  start_at bigint not null,
  end_at bigint,
  duration_ms bigint default 0 not null
);

-- ─── ОГРАНИЧЕНИЯ: ключи, уникальность, проверки, внешние ключи ───

alter table account_activity add constraint account_activity_pkey PRIMARY KEY (account_id);
alter table account_groups add constraint account_groups_pkey PRIMARY KEY (id);
alter table accounts_meta add constraint accounts_meta_pkey PRIMARY KEY (id);
alter table agents add constraint agents_pkey PRIMARY KEY (id);
alter table app_settings add constraint app_settings_pkey PRIMARY KEY (key);
alter table automation_rule_accounts add constraint automation_rule_accounts_pkey PRIMARY KEY (rule_id, account_id);
alter table automation_rules add constraint automation_rules_pkey PRIMARY KEY (id);
alter table bundle_modules add constraint bundle_modules_pkey PRIMARY KEY (bundle_id, module_id);
alter table bundles add constraint bundles_pkey PRIMARY KEY (id);
alter table campaign_modules add constraint campaign_modules_pkey PRIMARY KEY (campaign_id, module_id);
alter table campaign_schedules add constraint campaign_schedules_pkey PRIMARY KEY (id);
alter table campaigns add constraint campaigns_pkey PRIMARY KEY (id);
alter table channels add constraint channels_pkey PRIMARY KEY (id);
alter table coin_balance add constraint coin_balance_pkey PRIMARY KEY (user_id);
alter table daily_actions add constraint daily_actions_pkey PRIMARY KEY (account_id, day, action);
alter table goals add constraint goals_pkey PRIMARY KEY (id);
alter table kb_files add constraint kb_files_pkey PRIMARY KEY (id);
alter table knowledge_base add constraint knowledge_base_pkey PRIMARY KEY (id);
alter table leads add constraint leads_pkey PRIMARY KEY (id);
alter table link_hits add constraint link_hits_pkey PRIMARY KEY (id);
alter table messages add constraint messages_pkey PRIMARY KEY (id);
alter table model_prices add constraint model_prices_pkey PRIMARY KEY (model);
alter table module_actions add constraint module_actions_pkey PRIMARY KEY (id);
alter table module_presets add constraint module_presets_pkey PRIMARY KEY (id);
alter table module_prices add constraint module_prices_pkey PRIMARY KEY (module_id);
alter table modules add constraint modules_pkey PRIMARY KEY (id);
alter table parser_cache add constraint parser_cache_pkey PRIMARY KEY (sig);
alter table payments add constraint payments_pkey PRIMARY KEY (id);
alter table price_overrides add constraint price_overrides_pkey PRIMARY KEY (id);
alter table profiles add constraint profiles_pkey PRIMARY KEY (id);
alter table roles add constraint roles_pkey PRIMARY KEY (id);
alter table schema_migrations add constraint schema_migrations_pkey PRIMARY KEY (name);
alter table setup_modules add constraint setup_modules_pkey PRIMARY KEY (setup_id, module_key);
alter table setups add constraint setups_pkey PRIMARY KEY (id);
alter table subscriptions add constraint subscriptions_pkey PRIMARY KEY (id);
alter table target_folder_targets add constraint target_folder_targets_pkey PRIMARY KEY (folder_id, username);
alter table target_folders add constraint target_folders_pkey PRIMARY KEY (id);
alter table ticket_messages add constraint ticket_messages_pkey PRIMARY KEY (id);
alter table tickets add constraint tickets_pkey PRIMARY KEY (id);
alter table token_ledger add constraint token_ledger_pkey PRIMARY KEY (id);
alter table tracked_links add constraint tracked_links_pkey PRIMARY KEY (id);
alter table trust_cache add constraint trust_cache_pkey PRIMARY KEY (account_id);
alter table user_ai_settings add constraint user_ai_settings_pkey PRIMARY KEY (user_id);
alter table user_gifts add constraint user_gifts_pkey PRIMARY KEY (id);
alter table user_prompts add constraint user_prompts_pkey PRIMARY KEY (id);
alter table user_subscriptions add constraint user_subscriptions_pkey PRIMARY KEY (id);
alter table user_type_modules add constraint user_type_modules_pkey PRIMARY KEY (user_type_id, module_id);
alter table user_types add constraint user_types_pkey PRIMARY KEY (id);
alter table users add constraint users_pkey PRIMARY KEY (id);
alter table wallet_log add constraint wallet_log_pkey PRIMARY KEY (id);
alter table work_log add constraint work_log_pkey PRIMARY KEY (id);
alter table modules add constraint modules_key_key UNIQUE (key);
alter table profiles add constraint profiles_legacy_id_key UNIQUE (legacy_id);
alter table tracked_links add constraint tracked_links_code_key UNIQUE (code);
alter table user_gifts add constraint user_gifts_user_id_module_key_key UNIQUE (user_id, module_key);
alter table user_prompts add constraint user_prompts_user_id_module_key_idx_key UNIQUE (user_id, module_key, idx);
alter table user_subscriptions add constraint user_subscriptions_user_id_module_key_key UNIQUE (user_id, module_key);
alter table user_types add constraint user_types_name_key UNIQUE (name);
alter table users add constraint users_email_key UNIQUE (email);
alter table automation_rules add constraint automation_rules_schedule_chk CHECK ((schedule_type = ANY (ARRAY['once'::text, 'interval'::text, 'daily'::text])));
alter table knowledge_base add constraint knowledge_base_kind_chk CHECK ((kind = ANY (ARRAY['text'::text, 'file'::text, 'image'::text, 'link'::text])));
alter table messages add constraint messages_direction_check CHECK ((direction = ANY (ARRAY['in'::text, 'out'::text])));
alter table modules add constraint modules_key_check CHECK ((key ~ '^[a-z][a-z0-9_-]*$'::text));
alter table ticket_messages add constraint ticket_messages_side_chk CHECK ((side = ANY (ARRAY['user'::text, 'support'::text])));
alter table tickets add constraint tickets_status_chk CHECK ((status = ANY (ARRAY['open'::text, 'progress'::text, 'waiting'::text, 'escalated'::text, 'closed'::text])));
alter table user_types add constraint user_types_name_check CHECK (((char_length(name) >= 2) AND (char_length(name) <= 40)));
alter table user_types add constraint user_types_name_check1 CHECK ((name ~ '^[a-z][a-z0-9_-]*$'::text));
alter table account_groups add constraint account_groups_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table accounts_meta add constraint accounts_meta_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table automation_rule_accounts add constraint automation_rule_accounts_rule_id_fkey FOREIGN KEY (rule_id) REFERENCES automation_rules(id) ON DELETE CASCADE;
alter table bundle_modules add constraint bundle_modules_bundle_id_fkey FOREIGN KEY (bundle_id) REFERENCES bundles(id) ON DELETE CASCADE;
alter table bundle_modules add constraint bundle_modules_module_id_fkey FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
alter table campaign_modules add constraint campaign_modules_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE;
alter table campaign_modules add constraint campaign_modules_module_id_fkey FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
alter table campaign_schedules add constraint campaign_schedules_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table campaigns add constraint campaigns_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL;
alter table campaigns add constraint campaigns_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table channels add constraint channels_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table goals add constraint goals_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table leads add constraint leads_goal_id_fkey FOREIGN KEY (goal_id) REFERENCES goals(id) ON DELETE SET NULL;
alter table leads add constraint leads_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table link_hits add constraint link_hits_code_fkey FOREIGN KEY (code) REFERENCES tracked_links(code) ON DELETE CASCADE;
alter table messages add constraint messages_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table module_prices add constraint module_prices_module_id_fkey FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
alter table profiles add constraint profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table profiles add constraint profiles_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES profiles(id) ON DELETE SET NULL;
alter table profiles add constraint profiles_user_type_id_fkey FOREIGN KEY (user_type_id) REFERENCES user_types(id) ON DELETE SET NULL;
alter table roles add constraint roles_user_profile_fkey FOREIGN KEY (user_id) REFERENCES profiles(legacy_id) ON DELETE SET NULL;
alter table setup_modules add constraint setup_modules_setup_id_fkey FOREIGN KEY (setup_id) REFERENCES setups(id) ON DELETE CASCADE;
alter table target_folder_targets add constraint target_folder_targets_folder_id_fkey FOREIGN KEY (folder_id) REFERENCES target_folders(id) ON DELETE CASCADE;
alter table ticket_messages add constraint ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE;
alter table user_type_modules add constraint user_type_modules_module_id_fkey FOREIGN KEY (module_id) REFERENCES modules(id) ON DELETE CASCADE;
alter table user_type_modules add constraint user_type_modules_user_type_id_fkey FOREIGN KEY (user_type_id) REFERENCES user_types(id) ON DELETE CASCADE;
alter table users add constraint users_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES users(id) ON DELETE SET NULL;
alter table users add constraint users_user_type_id_fkey FOREIGN KEY (user_type_id) REFERENCES user_types(id) ON DELETE SET NULL;

-- ─── ИНДЕКСЫ (кроме тех, что стоят за ограничениями) ───

CREATE INDEX account_groups_user_id_idx ON public.account_groups USING btree (user_id);
CREATE INDEX accounts_meta_user_id_idx ON public.accounts_meta USING btree (user_id);
CREATE INDEX agents_user_id_idx ON public.agents USING btree (user_id);
CREATE INDEX audit_log_action_idx ON public.audit_log USING btree (action);
CREATE INDEX audit_log_initiator_idx ON public.audit_log USING btree (initiator);
CREATE INDEX audit_log_ts_idx ON public.audit_log USING btree (ts DESC);
CREATE INDEX automation_rule_accounts_idx ON public.automation_rule_accounts USING btree (rule_id, "position");
CREATE INDEX automation_rules_due_idx ON public.automation_rules USING btree (next_run) WHERE enabled;
CREATE INDEX automation_rules_owner_idx ON public.automation_rules USING btree (user_id);
CREATE INDEX campaign_schedules_user_id_idx ON public.campaign_schedules USING btree (user_id);
CREATE INDEX campaigns_user_id_idx ON public.campaigns USING btree (user_id);
CREATE UNIQUE INDEX channels_peer_uniq ON public.channels USING btree (tg_peer_id) WHERE (tg_peer_id IS NOT NULL);
CREATE INDEX channels_rating_idx ON public.channels USING btree (rating DESC NULLS LAST);
CREATE INDEX channels_subscribers_idx ON public.channels USING btree (subscribers DESC);
CREATE INDEX channels_user_id_idx ON public.channels USING btree (user_id);
CREATE INDEX channels_username_idx ON public.channels USING btree (lower(username));
CREATE INDEX daily_actions_day_idx ON public.daily_actions USING btree (day);
CREATE INDEX goals_user_id_idx ON public.goals USING btree (user_id);
CREATE INDEX knowledge_base_goal_idx ON public.knowledge_base USING btree (goal_id, created_at DESC);
CREATE INDEX leads_status_idx ON public.leads USING btree (status);
CREATE INDEX leads_task_id_idx ON public.leads USING btree (task_id);
CREATE INDEX leads_user_id_idx ON public.leads USING btree (user_id);
CREATE INDEX link_hits_unique_idx ON public.link_hits USING btree (code, fp);
CREATE INDEX messages_account_created_idx ON public.messages USING btree (account_id, created_at DESC);
CREATE INDEX messages_peer_created_idx ON public.messages USING btree (peer, created_at DESC);
CREATE INDEX messages_user_created_idx ON public.messages USING btree (user_id, created_at DESC);
CREATE INDEX module_actions_account_idx ON public.module_actions USING btree (account_id);
CREATE INDEX module_actions_task_idx ON public.module_actions USING btree (task_id);
CREATE INDEX module_actions_ts_idx ON public.module_actions USING btree (ts DESC);
CREATE INDEX module_actions_type_idx ON public.module_actions USING btree (type);
CREATE INDEX module_presets_module_idx ON public.module_presets USING btree (module_key);
CREATE INDEX module_presets_owner_idx ON public.module_presets USING btree (user_id);
CREATE INDEX parser_cache_error_idx ON public.parser_cache USING btree (last_error) WHERE (last_error IS NOT NULL);
CREATE INDEX parser_cache_kind_idx ON public.parser_cache USING btree (kind);
CREATE INDEX parser_cache_owner_idx ON public.parser_cache USING btree (owner_id);
CREATE INDEX parser_cache_updated_idx ON public.parser_cache USING btree (updated_at DESC);
CREATE INDEX parser_cache_watch_idx ON public.parser_cache USING btree (watch, next_run_at) WHERE watch;
CREATE INDEX payments_kind_ts_idx ON public.payments USING btree (kind, ts DESC);
CREATE INDEX payments_ts_idx ON public.payments USING btree (ts DESC);
CREATE INDEX payments_user_idx ON public.payments USING btree (user_id);
CREATE INDEX profiles_legacy_id_idx ON public.profiles USING btree (legacy_id);
CREATE INDEX roles_user_id_idx ON public.roles USING btree (user_id);
CREATE INDEX setup_modules_setup_idx ON public.setup_modules USING btree (setup_id);
CREATE INDEX subscriptions_billing_idx ON public.subscriptions USING btree (billing_day, last_credit_month);
CREATE INDEX target_folder_targets_idx ON public.target_folder_targets USING btree (folder_id, "position");
CREATE INDEX target_folders_owner_idx ON public.target_folders USING btree (user_id);
CREATE INDEX ticket_messages_tid_idx ON public.ticket_messages USING btree (ticket_id, ts);
CREATE INDEX tickets_to_owner_id_idx ON public.tickets USING btree (to_owner_id);
CREATE INDEX tickets_updated_idx ON public.tickets USING btree (updated_at DESC);
CREATE INDEX tickets_user_idx ON public.tickets USING btree (user_id);
CREATE INDEX token_ledger_module_idx ON public.token_ledger USING btree (module, ts DESC);
CREATE INDEX token_ledger_ts_idx ON public.token_ledger USING btree (ts DESC);
CREATE INDEX tracked_links_goal_idx ON public.tracked_links USING btree (goal_id);
CREATE INDEX tracked_links_owner_idx ON public.tracked_links USING btree (user_id);
CREATE INDEX user_gifts_user_idx ON public.user_gifts USING btree (user_id);
CREATE INDEX user_prompts_owner_idx ON public.user_prompts USING btree (user_id, module_key);
CREATE INDEX user_subscriptions_due_idx ON public.user_subscriptions USING btree (expires_at);
CREATE INDEX user_subscriptions_user_idx ON public.user_subscriptions USING btree (user_id);
CREATE INDEX users_parent_idx ON public.users USING btree (parent_id);
CREATE INDEX users_user_type_id_idx ON public.users USING btree (user_type_id);
CREATE INDEX wallet_log_actor_idx ON public.wallet_log USING btree (actor_id, ts DESC);
CREATE INDEX wallet_log_currency_idx ON public.wallet_log USING btree (currency);
CREATE INDEX wallet_log_kind_idx ON public.wallet_log USING btree (kind);
CREATE INDEX wallet_log_user_idx ON public.wallet_log USING btree (user_id, ts DESC);
CREATE INDEX work_log_open_idx ON public.work_log USING btree (user_id) WHERE (end_at IS NULL);
CREATE INDEX work_log_user_idx ON public.work_log USING btree (user_id, start_at DESC);

-- ─── ФУНКЦИИ ───

CREATE OR REPLACE FUNCTION public.bump_daily_action(p_account text, p_day text, p_action text)
 RETURNS integer
 LANGUAGE sql
AS $function$
  insert into daily_actions (account_id, day, action, count, updated_at)
  values (p_account, p_day, p_action, 1, now())
  on conflict (account_id, day, action)
    do update set count = daily_actions.count + 1, updated_at = now()
  returning count;
$function$
;

CREATE OR REPLACE FUNCTION public.cascade_owner_block()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if (new.active is distinct from old.active) and new.active = false then
    update public.profiles
       set active = false, updated_at = now()
     where parent_id = new.id
       and active = true;
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  insert into public.profiles (id, legacy_id, name, active)
  values (
    new.id,
    'usr_' || substr(replace(new.id::text, '-', ''), 1, 12),
    coalesce(nullif(new.raw_user_meta_data ->> 'name', ''), split_part(new.email, '@', 1)),
    true
  )
  on conflict (id) do nothing;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.is_active_profile()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$ select exists (select 1 from public.profiles where id = auth.uid() and active = true); $function$
;

CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$
;

-- ─── ТРИГГЕРЫ ───

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION handle_new_auth_user();
CREATE TRIGGER trg_cascade_owner_block AFTER UPDATE OF active ON public.profiles FOR EACH ROW EXECUTE FUNCTION cascade_owner_block();
create event trigger ensure_rls on ddl_command_end execute function rls_auto_enable;
create event trigger issue_graphql_placeholder on sql_drop execute function set_graphql_placeholder;
create event trigger issue_pg_cron_access on ddl_command_end execute function grant_pg_cron_access;
create event trigger issue_pg_graphql_access on ddl_command_end execute function grant_pg_graphql_access;
create event trigger issue_pg_net_access on ddl_command_end execute function grant_pg_net_access;
create event trigger pgrst_ddl_watch on ddl_command_end execute function pgrst_ddl_watch;
create event trigger pgrst_drop_watch on sql_drop execute function pgrst_drop_watch;

-- ─── RLS ───

alter table account_activity enable row level security;
alter table account_groups enable row level security;
alter table accounts_meta enable row level security;
alter table agents enable row level security;
alter table app_settings enable row level security;
alter table audit_log enable row level security;
alter table automation_rule_accounts enable row level security;
alter table automation_rules enable row level security;
alter table bundle_modules enable row level security;
alter table bundles enable row level security;
alter table campaign_modules enable row level security;
alter table campaign_schedules enable row level security;
alter table campaigns enable row level security;
alter table channels enable row level security;
alter table coin_balance enable row level security;
alter table daily_actions enable row level security;
alter table goals enable row level security;
alter table kb_files enable row level security;
alter table knowledge_base enable row level security;
alter table leads enable row level security;
alter table link_hits enable row level security;
alter table messages enable row level security;
alter table model_prices enable row level security;
alter table module_actions enable row level security;
alter table module_presets enable row level security;
alter table module_prices enable row level security;
alter table modules enable row level security;
alter table parser_cache enable row level security;
alter table payments enable row level security;
alter table price_overrides enable row level security;
alter table profiles enable row level security;
alter table roles enable row level security;
alter table schema_migrations enable row level security;
alter table setup_modules enable row level security;
alter table setups enable row level security;
alter table subscriptions enable row level security;
alter table target_folder_targets enable row level security;
alter table target_folders enable row level security;
alter table ticket_messages enable row level security;
alter table tickets enable row level security;
alter table token_ledger enable row level security;
alter table tracked_links enable row level security;
alter table trust_cache enable row level security;
alter table user_ai_settings enable row level security;
alter table user_gifts enable row level security;
alter table user_prompts enable row level security;
alter table user_subscriptions enable row level security;
alter table user_type_modules enable row level security;
alter table user_types enable row level security;
alter table users enable row level security;
alter table wallet_log enable row level security;
alter table work_log enable row level security;

-- ─── ПОЛИТИКИ ───

create policy "account_activity: active profiles only" on account_activity for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "account_groups: active profiles only" on account_groups for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "accounts_meta: active profiles only" on accounts_meta for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "agents: active profiles only" on agents for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "bundle_modules: active profiles only" on bundle_modules for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "bundles: active profiles only" on bundles for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "campaign_modules: active profiles only" on campaign_modules for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "campaign_schedules: active profiles only" on campaign_schedules for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "campaigns: active profiles only" on campaigns for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "channels: active profiles only" on channels for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "coin_balance: active profiles only" on coin_balance for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "goals: active profiles only" on goals for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "leads: active profiles only" on leads for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "messages: active profiles only" on messages for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy model_prices_read on model_prices for select
  using (true);
create policy "module_prices: active profiles only" on module_prices for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "modules: active profiles only" on modules for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "profiles: active profiles only" on profiles for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "roles: active profiles only" on roles for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy setup_modules_read on setup_modules for select
  using (true);
create policy setups_read on setups for select
  using (true);
create policy "subscriptions: active profiles only" on subscriptions for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "token_ledger: active profiles only" on token_ledger for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "user_type_modules: active profiles only" on user_type_modules for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "user_types: active profiles only" on user_types for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());
create policy "wallet_log: active profiles only" on wallet_log for all to authenticated
  using (is_active_profile())
  with check (is_active_profile());

-- ─── КОММЕНТАРИИ ───

comment on column automation_rules.settings is 'Снимок настроек запуска целиком. jsonb осознанно: набор полей свой у каждого модуля. Аккаунты вынесены отдельной таблицей — их считают и фильтруют.';
comment on column coin_balance.usd is 'Денежный баланс ($). Им платят за подписку и покупают токены (coins).';
comment on column knowledge_base.file_ref is 'Ссылка на kb_files.id. НЕ внешний ключ намеренно: у текстовых записей вложения нет, а удаление файла не должно уносить саму запись.';
comment on column leads.task_id is 'Задача (task.id), с которой лид попал в CRM (§9).';
comment on column link_hits.fp is 'Хеш от IP и user-agent. Сырые адреса посетителей не храним: для счётчика переходов они не нужны.';
comment on column module_presets.owner_label is 'Подпись «чей шаблон» из формы сохранения. Это текст для глаз, права доступа определяет user_id.';
comment on column module_presets.settings is 'Снимок настроек запуска целиком. jsonb осознанно: набор полей свой у каждого модуля и осмыслен только целиком, по строкам его раскладывать нечего.';
comment on column price_overrides.periods is 'Периоды подписки: [{unit:week|month|year, count:int, discount:0..0.9}]. NULL = дефолт (месяц 0% + год annual_discount).';
comment on column profiles.tokens_valid_from is 'MR-203: токены, выданные раньше этого момента, не принимаются (гасятся выходом).';
comment on column subscriptions.last_charge_month is 'За какой месяц уже списали деньги за продление (YYYY-MM, UTC). Защита от повторного списания, если процесс умер между списанием и сдвигом срока.';
comment on column subscriptions.last_credit_at is 'Момент последнего начисления месячных токенов. Следующее — через 30 суток после него.';
comment on column ticket_messages.author_name is 'Имя автора НА МОМЕНТ ОТПРАВКИ. Денормализовано намеренно: история переписки не должна меняться, когда человек сменил роль или ушёл.';
comment on column user_ai_settings.global_prompt is 'Пусто — своего промпта нет, подставляется прежний общий текст. Первое сохранение заводит личный.';
comment on column work_log.end_at is 'NULL — сессия открыта. Незакрытую в отчёте ограничивают потолком смены (OPEN_SESSION_CAP_MS): человек не работает 98 часов подряд, это просто не нажатый выход.';
comment on table audit_log is 'Единый аудит-лог (§11.1): входы/IP, статусы, баланс, роли, задачи.';
comment on table automation_rules is 'Правила автоматизации. Переехали из server/data/automation/rules.json (27.08, MR-186): у каждого инстанса был свой файл, и правило, выключенное на одном сервере, на другом продолжало запускаться.';
comment on table kb_files is 'Вложения базы знаний, содержимое прямо в базе. Переехали из каталога server/data/kb-files/ (27.08, MR-186): файл на диске одного инстанса для второго не существует.';
comment on table knowledge_base is 'База знаний цели. Переехала из server/data/knowledge.json (27.08, MR-186): файл на одной машине, второй инстанс отдавал бы в промпт неполные факты.';
comment on table link_hits is 'Переходы по ссылкам, строка на клик. Переехали из server/data/link-hits.jsonl. Индекс (code, fp) заменил чтение всего журнала на каждый клик.';
comment on table module_presets is 'Шаблоны настроек модулей. Переехали из файлов server/data/modules/*/presets.json (26.08): файловое хранение расходилось между инстансами и нарушало правило «только общая база».';
comment on table target_folder_targets is 'Цели папки построчно. Первичный ключ (папка, канал) не даёт завести один канал дважды — раньше дубли приводили к повторной обработке канала одним аккаунтом, а это сигнатура бота.';
comment on table target_folders is 'Папки целей. Переехали из server/data/target-folders.json (27.08, MR-186): файл на одной машине, у пути даже не было env — тесты писали туда же, куда боевой сервер.';
comment on table ticket_messages is 'Переписка по обращению, по строке на сообщение. Отдельная таблица, а не поле-JSON: по сообщениям считают непрочитанное и сортируют — это данные, а не снимок.';
comment on table tickets is 'Обращения в поддержку. Переехали из server/data/tickets.json (27.08, MR-186): файл жил на одной машине, второй инстанс не видел половину обращений.';
comment on table tracked_links is 'Отслеживаемые короткие ссылки. Переехали из server/data/links.json (27.08, MR-186): при втором инстансе половина кликов уходила бы в файл одного сервера, половина другого.';
comment on table user_ai_settings is 'MR-185: персональные ИИ-настройки. Глобальный системный промпт принадлежит человеку: правка одного не доезжает до других.';
comment on table user_gifts is 'MR-189: журнал выданных подарочных ⚡. Подарок даётся один раз за пару «пользователь + модуль» и не выдаётся повторно при возврате модуля в подписку.';
comment on table users is 'Хранилище пароля для входа (password_hash). Профили людей — в profiles; здесь только учётные данные. Не удалять, пока вход по паролю читает эту таблицу.';
comment on table work_log is 'Сессии труда операторов (вход→выход). Переехали из server/data/worklog.json (27.08, MR-186): файл жил на одной машине, при втором инстансе смена не закрывалась.';
