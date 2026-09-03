-- §5.4 (MR-37): владелец назначает субпользователю аккаунты из своего пула — прямыми
-- грантами на профиле суба: группы аккаунтов и/или отдельные аккаунты. Эти гранты
-- вливаются в эффективные права суба (resources.accountGroups/accounts = allow) при
-- сборке прав на входе и /me, поэтому весь существующий резолвер доступа работает без
-- изменений (isAccountAllowedViaGroups). Пустой массив = ничего не выдано.

alter table public.profiles
  add column if not exists account_ids text[] not null default '{}',
  add column if not exists account_group_ids text[] not null default '{}';
