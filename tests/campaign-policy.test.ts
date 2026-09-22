import { expect, test } from "bun:test";
import { assertCampaignRoute } from "../src/campaign-policy";
import { requireChatGptWebModelRoute } from "../src/chatgpt-web-models";
import { defaultConfig } from "../src/config";
import { responseRequest } from "../src/server";

test("campaign policy gates actual Pro generation but permits non-Pro efforts on Pro accounts and rejects native fallback", async () => {
  const previous = process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID;
  process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = crypto.randomUUID();
  const config = defaultConfig('browser-only'); config.solAvailable = true; config.proAvailable = true;
  try {
    for (const model of ['chatgpt-web/light', 'chatgpt-web/medium', 'chatgpt-web/high', 'chatgpt-web/extra-high']) expect(() => assertCampaignRoute(requireChatGptWebModelRoute(model, config))).not.toThrow();
    expect(() => assertCampaignRoute(requireChatGptWebModelRoute('chatgpt-web/pro', config))).toThrow('Pro generation is disabled');
    const response = await responseRequest(new Request('http://127.0.0.1/v1/responses', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-6-astra', input: 'synthetic child fallback' }) }), config);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('Native model fallback is disabled');
  } finally { if (previous === undefined) delete process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID; else process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID = previous; }
});
