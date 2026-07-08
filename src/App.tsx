import { Routes, Route, Navigate } from 'react-router-dom'
import { useApp } from '@/mocks/store'
import { Layout } from '@/app/Layout'
import { AccountsPage } from '@/pages/AccountsPage'
import { StatisticsPage } from '@/pages/StatisticsPage'
import { SupportPage } from '@/pages/SupportPage'
import { ModuleRunner } from '@/pages/ModuleRunner'
import { ParsingHistoryPage } from '@/pages/ParsingHistoryPage'
import { ProfilePage } from '@/pages/ProfilePage'
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
