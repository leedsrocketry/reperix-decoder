import { useEffect, useState } from 'react'
import { Plug, PlugZap } from 'lucide-react'
import { useConnection } from '@/context/ConnectionContext'
import { cn } from '@/lib/utils'

function timeSince(date: Date): string {
  const s = Math.floor((Date.now() - date.getTime()) / 1000)
  if (s < 5)  return 'just now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

export default function StatusBar() {
  const { connected, status, lastPacketAt, blink, toggle } = useConnection()
  const [, tick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex flex-shrink-0 items-center gap-3 border-b border-border bg-background px-4 py-2">
      {/* Indicator dot */}
      <span className="relative flex h-2.5 w-2.5 items-center justify-center">
        {blink && (
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-green-400 opacity-75" />
        )}
        <span className={cn(
          'relative inline-flex h-2 w-2 rounded-full transition-colors duration-200',
          blink      ? 'bg-green-300' :
          connected  ? 'bg-green-500' :
                       'bg-muted-foreground/30'
        )} />
      </span>

      {/* Status text */}
      <span className="text-xs text-muted-foreground">{status}</span>

      {/* Last packet */}
      {lastPacketAt && (
        <>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-xs text-muted-foreground/60">
            last packet <span className="tabular-nums">{timeSince(lastPacketAt)}</span>
          </span>
        </>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Connect / disconnect */}
      <button
        onClick={toggle}
        className={cn(
          'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors',
          connected
            ? 'border-destructive/50 text-destructive hover:bg-destructive/10'
            : 'border-border hover:bg-accent'
        )}
      >
        {connected
          ? <><PlugZap className="h-3.5 w-3.5" /> Disconnect</>
          : <><Plug    className="h-3.5 w-3.5" /> Connect</>
        }
      </button>
    </div>
  )
}
