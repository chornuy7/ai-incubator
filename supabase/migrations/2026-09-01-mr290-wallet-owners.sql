-- MR-290, шаг 4: владелец денег становится сущностью, а не строкой-меткой.
--
-- Почему денежные таблицы не попали в шаг с внешними ключами. В колонке `user_id` у
-- coin_balance, wallet_log, payments, token_ledger, subscriptions и user_subscriptions
-- лежат ТРИ разных вида значений:
--
--   • идентификатор профиля (usr_…) — обычный владелец-человек;
--   • служебная метка `__default` — «Системный кошелёк» платформы (server/balance.js:347):
--     им платят фоновые списания и внутренние вызовы, человеку он не принадлежит;
--   • служебная метка `workspace` — общая подписка пространства.
--
-- Плюс к этому в боевых данных есть тринадцать идентификаторов, записанных ПРОГОНАМИ
-- ТЕСТОВ прямо в боевую базу 20–21.08 (usr_mr150_probe, usr_bill_test, usr_nojson и
-- прочие) — 27 строк оплат и 12 строк кошелька.
--
-- Внешний ключ на profiles поверх такой колонки поставить нельзя: он снёс бы 370 строк
-- журнала кошелька из 1187 и 95 оплат из 151. А оставить как есть — значит навсегда
-- держать деньги на единственной защите «код положит правильную строку».
--
-- РЕШЕНИЕ: завести справочник владельцев кошелька. Каждое значение, которое реально
-- встречается, становится СТРОКОЙ СПРАВОЧНИКА со своим видом. Служебные ключи перестают
-- быть магией в коде и становятся данными, тестовые записи получают честную пометку
-- (решение владельца 01.09: пометить, не удалять — история оплат не должна рваться), а
-- денежные таблицы закрываются обычными внешними ключами, ничего не теряя.

create table if not exists wallet_owners (
  id         text primary key,
  -- user      — человек, есть профиль;
  -- system    — сама платформа (__default): фоновые списания, внутренние вызовы;
  -- workspace — общее пространство (workspace/__workspace__): подписка на всех;
  -- test      — запись прогоном тестов в боевую базу. Не владелец, а след аварии.
  kind       text not null check (kind in ('user', 'system', 'workspace', 'test')),
  -- Живая ссылка на человека. NULL у служебных и тестовых, а также у человека, чей
  -- профиль удалили: сам владелец кошелька при этом остаётся — иначе история платежей
  -- потеряла бы того, кому принадлежала.
  profile_id text references profiles(legacy_id) on update cascade on delete set null,
  note       text not null default '',
  created_at timestamptz not null default now(),
  constraint wallet_owners_profile_chk check (kind = 'user' or profile_id is null)
);
create index if not exists wallet_owners_profile_idx on wallet_owners (profile_id);
create index if not exists wallet_owners_kind_idx    on wallet_owners (kind);

comment on table wallet_owners is
  'Владельцы кошелька: люди и служебные (система, пространство). Заведён в MR-290, чтобы деньги можно было закрыть внешними ключами: до него в колонке владельца лежали и профили, и строки-метки __default/workspace, и следы тестовых прогонов.';
comment on column wallet_owners.kind is
  'user — человек; system — платформа (__default); workspace — общее пространство; test — запись прогоном тестов в бой. Отчёты по деньгам фильтруют по этому полю, а не по списку строк в коде.';

-- ─────────────────────────────────────────────────────────────
-- 1. Наполнение справочника
-- ─────────────────────────────────────────────────────────────

-- Люди — все профили разом. `on conflict do nothing` делает миграцию идемпотентной.
insert into wallet_owners (id, kind, profile_id, note)
select p.legacy_id, 'user', p.legacy_id, ''
from profiles p
where p.legacy_id is not null
on conflict (id) do nothing;

-- Служебные. `__workspace__` в данных сейчас не встречается, но код его знает
-- (SKIP в server/tokenCredit.js и server/subscriptionBilling.js) — заводим заранее,
-- иначе первая же запись под этим ключом упрётся во внешний ключ на боевой.
insert into wallet_owners (id, kind, note) values
  ('__default',     'system',    'Системный кошелёк платформы: фоновые списания и внутренние вызовы. Человеку не принадлежит.'),
  ('workspace',     'workspace', 'Общая подписка пространства: действует на всех, у кого нет личной.'),
  ('__workspace__', 'workspace', 'Второе имя общего пространства, встречается в коде. Оставлено, чтобы запись под ним не падала.')
on conflict (id) do nothing;

-- Следы тестовых прогонов. Список закрыт и составлен по факту: это ровно те значения,
-- которые встречаются в боевых деньгах и не являются ни профилем, ни служебным ключом.
-- Строки НЕ удаляются: они связаны с реальными записями журнала кошелька и оплат, и
-- вычеркнуть их значит порвать историю там, где она уже посчитана в отчётах.
insert into wallet_owners (id, kind, note)
select v, 'test', 'Запись прогоном тестов в боевую базу 20–21.08. Не владелец: в отчётах по деньгам такие строки исключают по kind.'
from (values
  ('usr_mr150_probe'), ('usr_mr150_probe2'), ('usr_mr150_probe3'), ('usr_mr150_final'),
  ('usr_mr150_credit'), ('usr_bill_test'), ('usr_credit_test'), ('usr_full_check'),
  ('usr_contract_probe'), ('usr_nojson'), ('usr_after_drop'), ('usr_c3_probe'), ('usr_final173')
) as t(v)
on conflict (id) do nothing;

-- ─────────────────────────────────────────────────────────────
-- 2. Две строки, где владельца не было никогда
-- ─────────────────────────────────────────────────────────────
-- Прочерк и пустая строка — это не идентификаторы и не метки: это «поле не заполнили».
-- Правильное выражение этого в базе — NULL, и обе колонки его допускают. Заводить на них
-- строку справочника значило бы сделать вид, что владелец известен.
update payments     set user_id = null where user_id = '—';
update token_ledger set user_id = null where user_id = '';

-- ─────────────────────────────────────────────────────────────
-- 3. Новый профиль сразу получает владельца кошелька
-- ─────────────────────────────────────────────────────────────
-- Без этого первый же баланс нового человека упрётся во внешний ключ. Триггер, а не вызов
-- из кода: профиль заводится тремя разными путями (админка, приглашение, OAuth через
-- handle_new_auth_user), и полагаться на то, что все три вспомнят про справочник, нельзя.
create or replace function public.ensure_wallet_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.wallet_owners (id, kind, profile_id)
  values (new.legacy_id, 'user', new.legacy_id)
  on conflict (id) do update set kind = 'user', profile_id = excluded.profile_id;
  return new;
end;
$$;

drop trigger if exists trg_profile_wallet_owner on public.profiles;
create trigger trg_profile_wallet_owner
  after insert or update of legacy_id on public.profiles
  for each row when (new.legacy_id is not null)
  execute function public.ensure_wallet_owner();

comment on function public.ensure_wallet_owner is
  'MR-290: у каждого профиля есть строка в wallet_owners. Иначе первая же денежная запись нового человека упрётся во внешний ключ.';

-- ─────────────────────────────────────────────────────────────
-- 4. Деньги закрываются внешними ключами
-- ─────────────────────────────────────────────────────────────
-- RESTRICT везде. Удаление владельца, за которым числятся деньги, обязано упереться:
-- журнал кошелька и оплаты — это учёт, а не рабочие данные. Человека при этом удалить
-- по-прежнему можно: profiles(legacy_id) → wallet_owners.profile_id стоит SET NULL, то
-- есть уходит человек, а его кошелёк с историей остаётся.
create index if not exists coin_balance_owner_idx       on coin_balance (user_id);
create index if not exists payments_owner_idx           on payments (user_id);
create index if not exists token_ledger_owner_idx       on token_ledger (user_id);

alter table coin_balance       add constraint coin_balance_owner_fkey       foreign key (user_id) references wallet_owners(id) on delete restrict;
alter table wallet_log         add constraint wallet_log_owner_fkey         foreign key (user_id) references wallet_owners(id) on delete restrict;
alter table payments           add constraint payments_owner_fkey           foreign key (user_id) references wallet_owners(id) on delete restrict;
alter table token_ledger       add constraint token_ledger_owner_fkey       foreign key (user_id) references wallet_owners(id) on delete restrict;
alter table subscriptions      add constraint subscriptions_owner_fkey      foreign key (user_id) references wallet_owners(id) on delete restrict;
alter table user_subscriptions add constraint user_subscriptions_owner_fkey foreign key (user_id) references wallet_owners(id) on delete restrict;

comment on column payments.user_id is
  'Владелец оплаты — строка wallet_owners: человек, платформа или пространство. NULL — владельца не знали и в момент записи (две строки с прочерком, MR-290).';
