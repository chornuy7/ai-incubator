-- §4.2 (MR-30): баланс субпользователя. По умолчанию общий с владельцем (суб тратит из
-- кошелька владельца), либо индивидуальный лимит токенов (свой кошелёк). Режим и лимит
-- задаются при добавлении суба.
--   balance_mode: 'shared' (по умолчанию) | 'individual'
--   token_limit:  ориентировочный лимит токенов для индивидуального режима (null = без явного)

alter table public.profiles
  add column if not exists balance_mode text not null default 'shared',
  add column if not exists token_limit numeric;
