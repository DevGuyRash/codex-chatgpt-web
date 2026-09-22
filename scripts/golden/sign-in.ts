const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** A local handoff page contains no authentication inputs and never observes sign-in. */
export function signInPage(viewerUrl: string): string {
  const url = new URL(viewerUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/vnc.html") throw new Error("Test sign-in must use the owned loopback viewer");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Sign in to the isolated test workspace</title>
<style>body{margin:0;background:#f4f6f8;color:#172431;font:18px/1.55 system-ui,sans-serif}main{max-width:620px;margin:10vh auto;padding:32px}h1{font-size:32px;line-height:1.2}a{color:#174c83}a.button{display:inline-block;background:#174c83;color:white;border-radius:8px;padding:12px 20px;text-decoration:none;font-weight:650}a:focus-visible{outline:3px solid #a04c00;outline-offset:5px}.url{overflow-wrap:anywhere;font-size:14px}small{color:#485866}</style></head>
<body><main><p>Codex Web GPT · Isolated testing</p><h1>Sign in to the test workspace</h1><p>This test uses a separate browser profile. Open its browser below and sign in to ChatGPT once. Your normal browser session stays separate.</p>
<p><a class="button" href="${escape(url.href)}">Open test sign-in</a></p>
<p>When you have finished, return to the task and say that you are signed in. The test waits for that confirmation before checking the session. Authentication screens are excluded from test capture.</p>
<p><small>You can also copy this local URL into a browser on this computer:</small></p><p class="url"><a href="${escape(url.href)}">${escape(url.href)}</a></p>
</main></body></html>`;
}

export function signInMessage(input: { signInUrl: string; viewerUrl: string }): string {
  return `Isolated test workspace ready.\n\nOpen test sign-in: ${input.signInUrl}\nDirect browser viewer: ${input.viewerUrl}\n\nSign in to ChatGPT there once, then tell the task you are signed in. Authentication is excluded from test capture.\n`;
}
