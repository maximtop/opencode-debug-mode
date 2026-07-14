chrome.runtime.onMessage.addListener((message) => {
  if (message.type === "fixture-action") return Promise.resolve({ accepted: true })
})
