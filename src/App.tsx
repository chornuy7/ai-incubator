import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/mocks/store'
import { useSession } from '@/features/auth/session'
import { Layout } from '@/app/Layout'
import { AccountsPage } from '@/pages/AccountsPage'
import { StatisticsPage } from '@/pages/StatisticsPage'
import { SupportPage } from '@/pages/SupportPage'
import { ModuleRunner } from '@/pages/ModuleRunner'
import { ParsingHistoryPage } from '@/pages/ParsingHistoryPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { LearningPage } from '@/pages/LearningPage'
import { SubscriptionPage } from '@/pages/SubscriptionPage'
import { AutomationPage } from '@/pages/AutomationPage'
import { GoalsPage } from '@/pages/GoalsPage'
import { AgentsPage } from '@/pages/AgentsPage'
import { TasksPage, TaskDetailPage } from '@/pages/TasksPage'
import { AccountOverviewPage } from '@/features/account-manager/AccountOverviewPage'
import { LeadsPage } from '@/pages/LeadsPage'
import { AdminEntry } from '@/pages/AdminEntry'
import { LandingPage } from '@/pages/LandingPage'
import { ModuleLandingPage } from '@/pages/landing/ModuleLandingPage'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { CampaignPage } from '@/pages/CampaignPage'
import { ChannelsPage } from '@/pages/ChannelsPage'
import { LogsPage } from '@/pages/LogsPage'
import { InboxPage } from '@/pages/InboxPage'
import { RolesPage } from '@/pages/RolesPage'
import { UsersPage } from '@/pages/UsersPage'
import { ProxiesPage } from '@/pages/ProxiesPage'
import { MailingPage } from '@/pages/MailingPage'
import { AutopostingPage } from '@/pages/AutopostingPage'
import { GuestLogin } from '@/pages/GuestLogin'
import { SessionGuard } from '@/features/auth/SessionGuard'

export default function App() {
  const userState = useApp((s) => s.userState)
  const sessionUser = useSession((s) => s.user)

  // Панель доступна ТОЛЬКО с реальной сессией. Нет входа (или явный «гость») →
  // публичные страницы: лендинг, вход, админка. Раньше гейт стоял на dev-флаге
  // `userState`, и свежий посетитель без входа видел пустую панель (данные при этом
  // 401-ились сервером, но UX был сломан) вместо лендинга.
  if (!sessionUser || userState === 'guest') {
    // B1 (SPEC §5.2): лендинг — единственная страница ВНЕ auth-гейта. Раньше гость
    // на любом адресе видел форму входа: человек, пришедший по ссылке из рекламы,
    // упирался в логин, не понимая, что это за продукт.
    return (
      <Routes>
        <Route path="/" element={<LandingPage />} />
        {/* /landing — тот же лендинг под явным путём: авторизованный уходит на него по
            клику на логотип, и расшаренная гостю ссылка /landing должна открывать лендинг,
            а не форму входа. */}
        <Route path="/landing" element={<LandingPage />} />
        {/* Страницы модулей — часть публичного лендинга, доступны «гостю». */}
        <Route path="/module/:key" element={<ModuleLandingPage />} />
        {/* Админ-панель — отдельная ссылка со своим входом, доступна и «гостю». */}
        <Route path="/admin" element={<AdminEntry />} />
        <Route path="*" element={<GuestLogin />} />
      </Routes>
    )
  }

  return (
    <>
      {/* MR-141: локальный сторож — тайм-аут по бездействию + живость сессии/токена. */}
      <SessionGuard />
      <Routes>
      <Route element={<Layout />}>
        <Route path="/panel" element={<AccountsPage />} />
        <Route path="/panel/accounts/:id" element={<AccountOverviewPage />} />
        <Route path="/panel/automation" element={<AutomationPage />} />
        <Route path="/panel/goals" element={<GoalsPage />} />
        <Route path="/panel/agents" element={<AgentsPage />} />
        <Route path="/panel/tasks" element={<TasksPage />} />
        <Route path="/panel/tasks/:id" element={<TaskDetailPage />} />
        <Route path="/panel/crm" element={<LeadsPage />} />
        <Route path="/panel/analytics" element={<AnalyticsPage />} />
        <Route path="/panel/campaign" element={<CampaignPage />} />
        <Route path="/panel/channels" element={<ChannelsPage />} />
        <Route path="/panel/logs" element={<LogsPage />} />
        <Route path="/panel/inbox" element={<InboxPage />} />
        <Route path="/panel/my-statistics" element={<StatisticsPage />} />
        <Route path="/panel/support" element={<SupportPage />} />
        <Route path="/panel/modules/:moduleKey" element={<ModuleRunner />} />
        <Route path="/panel/parsing-history" element={<ParsingHistoryPage />} />
        <Route path="/panel/user/profile" element={<ProfilePage />} />
        <Route path="/panel/learning" element={<LearningPage />} />
        <Route path="/panel/user/subscription" element={<SubscriptionPage />} />
        <Route path="/panel/roles" element={<RolesPage />} />
        <Route path="/panel/users" element={<UsersPage />} />
        <Route path="/panel/proxies" element={<ProxiesPage />} />
        <Route path="/panel/mailing" element={<MailingPage />} />
        <Route path="/panel/autoposting" element={<AutopostingPage />} />
      </Route>
      {/* Админ-панель — вне Layout: своя шапка, свой вход, отдельная ссылка. */}
      <Route path="/admin" element={<AdminEntry />} />
      {/* Публичный лендинг доступен и авторизованному (клик по логотипу): «/» уходит
          на панель, поэтому у лендинга свой путь /landing, без редиректа. */}
      <Route path="/landing" element={<LandingPage />} />
      <Route path="/module/:key" element={<ModuleLandingPage />} />
      <Route path="/" element={<Navigate to="/panel" replace />} />
      <Route path="*" element={<Navigate to="/panel" replace />} />
      </Routes>
    </>
  )
}
