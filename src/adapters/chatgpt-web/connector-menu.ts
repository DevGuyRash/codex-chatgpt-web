import type { Page } from "playwright-core";

/** The connector surface owns these rows; callers must still prove exact identity before acting. */
export const CHATGPT_CONNECTOR_ROW_SELECTOR = [
  '[data-composer-plugin-impression-id] > .__menu-item[tabindex="0"]',
  '[data-mention-list-scroll-area] [data-list-navigation-item="true"]',
].join(", ");

export function chatGptConnectorMenu(page: Page, name: string) {
  const rows = page.locator(CHATGPT_CONNECTOR_ROW_SELECTOR);
  return { rows, exact: rows.filter({ has: page.getByText(name, { exact: true }), visible: true }) };
}
