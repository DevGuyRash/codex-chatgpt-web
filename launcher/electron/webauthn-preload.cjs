const { contextBridge, ipcRenderer } = require("electron");

function subscribe(channel, listener) {
  const wrapped = (_event, value) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("codexPasskeyPrompt", {
  onState: listener => subscribe("launcher:webauthn-prompt-state", listener),
  onWaiting: listener => subscribe("launcher:webauthn-prompt-waiting", listener),
  current: () => ipcRenderer.invoke("launcher:webauthn-prompt-current"),
  respond: answer => ipcRenderer.invoke("launcher:webauthn-prompt-reply", answer),
});
