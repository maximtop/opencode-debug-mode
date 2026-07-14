export function relayDebugEvent(event) {
  return chrome.runtime.sendMessage({ type: "opencode-debug-event", event })
}
