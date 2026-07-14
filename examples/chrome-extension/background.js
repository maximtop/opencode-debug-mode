chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== "opencode-debug-event") return undefined
  // The temporary package-owned background helper accepts the bounded event.
  return globalThis.__opencodeDebugEmit?.(message.event)
})
