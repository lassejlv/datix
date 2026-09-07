// Keep operational paths stable when invoked from either the repository or web/.
process.chdir(new URL('../..', import.meta.url).pathname);
import type { Page } from '@playwright/test';
export async function chooseWorkspace(page: Page, kind: 'website' | 'environment', id: string) {
  await page.getByLabel(`Selected ${kind}`, { exact: true }).click();
  await page.locator(`[role="option"][data-value="${id}"]`).click();
}
