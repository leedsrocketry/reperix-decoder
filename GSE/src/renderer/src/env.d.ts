interface Window {
  api: {
    listSerialPorts: () => Promise<string[]>
    connect: (port: string, baud: number) => Promise<{ ok: boolean }>
    disconnect: () => Promise<{ ok: boolean }>
    onSerialData: (callback: (msg: unknown) => void) => () => void
  }
}
