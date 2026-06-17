import { Radio, Map, Settings, ScrollText } from 'lucide-react'
import { cn } from '@/lib/utils'

type Page = 'tracking' | 'map' | 'raw' | 'settings'

const NAV_ITEMS: { id: Page; label: string; icon: React.ElementType }[] = [
  { id: 'tracking', label: 'Tracking', icon: Radio },
  { id: 'map',      label: 'Map',      icon: Map },
  { id: 'raw',      label: 'Raw',      icon: ScrollText },
]

const BOTTOM_ITEMS: { id: Page; label: string; icon: React.ElementType }[] = [
  { id: 'settings', label: 'Settings', icon: Settings },
]

interface SidebarProps {
  activePage: Page
  onNavigate: (page: Page) => void
}

function NavButton({
  id, label, icon: Icon, activePage, onNavigate,
}: { id: Page; label: string; icon: React.ElementType; activePage: Page; onNavigate: (p: Page) => void }) {
  return (
    <button
      onClick={() => onNavigate(id)}
      title={label}
      className={cn(
        'flex h-12 w-12 flex-col items-center justify-center gap-1 rounded-lg text-xs transition-colors',
        activePage === id
          ? 'bg-sidebar-accent text-sidebar-accent-foreground'
          : 'text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground'
      )}
    >
      <Icon className="h-5 w-5" />
      <span className="text-[10px] leading-none">{label}</span>
    </button>
  )
}

export default function Sidebar({ activePage, onNavigate }: SidebarProps) {
  return (
    <aside className="flex h-full w-16 flex-col items-center border-r border-sidebar-border bg-sidebar py-4">
      <div className="mb-4 flex h-8 w-8 items-center justify-center">
        <Radio className="h-5 w-5 text-sidebar-primary" />
      </div>
      <nav className="flex flex-1 flex-col items-center gap-1">
        {NAV_ITEMS.map(item => (
          <NavButton key={item.id} {...item} activePage={activePage} onNavigate={onNavigate} />
        ))}
      </nav>
      <div className="flex flex-col items-center gap-1">
        {BOTTOM_ITEMS.map(item => (
          <NavButton key={item.id} {...item} activePage={activePage} onNavigate={onNavigate} />
        ))}
      </div>
    </aside>
  )
}

export type { Page }
