import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/mocks/store'
import { Layout } from '@/app/Layout'
import { AccountsPage } from '@/pages/AccountsPage'
import { StatisticsPage } from '@/pages/StatisticsPage'
import { SupportPage } from '@/pages/SupportPage'
import { ModuleRunner } from '@/pages/ModuleRunner'
import { ParsingHistoryPage } from '@/pages/ParsingHistoryPage'
import { ProfilePage } from '@/pages/ProfilePage'
import { AutomationPage } from '@/pages/AutomationPage'
import { GoalsPage } from '@/pages/GoalsPage'
import { TasksPage } from '@/pages/TasksPage'
import { LeadsPage } from '@/pages/LeadsPage'
import { AnalyticsPage } from '@/pages/AnalyticsPage'
import { CampaignPage } from '@/pages/CampaignPage'
import { ChannelsPage } from '@/pages/ChannelsPage'
import { LogsPage } from '@/pages/LogsPage'
import { GuestLogin } from '@/pages/GuestLogin'

export default function App() {
  const userState = useApp((s) => s.userState)

  if (userState === 'guest') {
    return (
      <Routes>
        <Route path="*" element={<GuestLogin />} />
      </Routes>
    )
  }

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/panel" element={<AccountsPage />} />
        <Route path="/panel/automation" element={<AutomationPage />} />
        <Route path="/panel/goals" element={<GoalsPage />} />
        <Route path="/panel/tasks" element={<TasksPage />} />
        <Route path="/panel/crm" element={<LeadsPage />} />
        <Route path="/panel/analytics" element={<AnalyticsPage />} />
        <Route path="/panel/campaign" element={<CampaignPage />} />
        <Route path="/panel/channels" element={<ChannelsPage />} />
        <Route path="/panel/logs" element={<LogsPage />} />
        <Route path="/panel/my-statistics" element={<StatisticsPage />} />
        <Route path="/panel/support" element={<SupportPage />} />
        <Route path="/panel/modules/:moduleKey" element={<ModuleRunner />} />
        <Route path="/panel/parsing-history" element={<ParsingHistoryPage />} />
        <Route path="/panel/user/profile" element={<ProfilePage />} />
      </Route>
      <Route path="/" element={<Navigate to="/panel" replace />} />
      <Route path="*" element={<Navigate to="/panel" replace />} />
    </Routes>
  )
}
