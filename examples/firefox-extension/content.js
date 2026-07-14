export function relayDebugEvent(event) {
  return browser.runtime.sendMessage({ type: "opencode-debug-event", event })
}
