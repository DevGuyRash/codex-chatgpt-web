import { CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL, type ChatGptWebModelRoute } from "./chatgpt-web-models";

export function campaignGenerationRestricted(): boolean {
  return Boolean(process.env.CODEX_WEB_GPT_CAPTURE_CAMPAIGN_ID);
}

export function isProGeneration(route: ChatGptWebModelRoute): boolean {
  return route.backendModel === CHATGPT_WEB_ZERO_RISK_PRO_BACKEND_MODEL || route.interactionMode === "automatic" && route.adapterEffort === "max";
}

export function assertCampaignRoute(route: ChatGptWebModelRoute): void {
  if (campaignGenerationRestricted() && isProGeneration(route)) throw new Error("Pro generation is disabled for this non-Pro campaign, including delegated work");
}
