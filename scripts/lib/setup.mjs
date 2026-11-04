/** Complete the real opening-roll controls before an integration test starts its campaign. */
export async function completeCampaignOpening(page) {
  await page.locator('[data-action="setup-roll"]').click();
  for (let round = 0; round < 50; round++) {
    await page.locator('[data-setup-opening-rolling="false"]').waitFor();
    const next = page.locator('[data-action="setup-reroll"],[data-action="create-game"]');
    await next.waitFor();
    if ((await next.getAttribute('data-action')) === 'create-game') return;
    await next.click();
  }
  throw new Error('Opening dice did not resolve within the browser fixture limit.');
}
