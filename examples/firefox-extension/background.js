browser.runtime.onMessage.addListener((message) => {
  if (message.type !== "opencode-debug-event") return undefined
  return globalThis.__opencodeDebugEmit?.(message.event)
})
