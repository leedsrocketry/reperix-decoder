import { useState } from 'react'
import { ThemeProvider } from '@/context/ThemeContext'
import Sidebar, { type Page } from '@/components/Sidebar'
import TrackingPage from '@/pages/TrackingPage'
import MapPage from '@/pages/MapPage'
import RawPage from '@/pages/RawPage'
import SettingsPage from '@/pages/SettingsPage'

const PAGES: Record<Page, React.ReactNode> = {
  tracking: <TrackingPage />,
  map:      <MapPage />,
  raw:      <RawPage />,
  settings: <SettingsPage />,
}

export default function App() {
  const [activePage, setActivePage] = useState<Page>('tracking')

  return (
    <ThemeProvider>
      <div className="flex h-screen overflow-hidden bg-background text-foreground">
        <Sidebar activePage={activePage} onNavigate={setActivePage} />
        <main className="flex-1 overflow-hidden">{PAGES[activePage]}</main>
      </div>
    </ThemeProvider>
  )
}
