import assert from 'node:assert/strict';
import { tutorialLessons } from '../../dist/ui/tutorial-lessons.js';

/** Read every adviser paragraph through Continue, checking none of the rules or examples is skipped. */
export async function prepareInstruction(page) {
  const expected = await page.locator('.tutorial-dialogue-script p').allTextContents();
  if (!expected.length) return [];
  const step = await page.locator('.tutorial-guide').getAttribute('data-tutorial-step');
  const lesson = tutorialLessons[step];
  for (const explanation of [lesson.summary, ...lesson.notes, ...(lesson.details || [])])
    assert.ok(
      expected.includes(explanation),
      'The dialogue must include every declared rule and example.',
    );
  const heard = [];
  const next = page.locator('[data-tutorial-dialogue-next]');
  for (let attempt = 0; attempt < expected.length * 3 + 3; attempt++) {
    const current = await page.locator('.tutorial-dialogue-text').textContent();
    if (heard.at(-1) !== current) heard.push(current);
    if (!(await next.isVisible())) break;
    // One click finishes typing; the following click advances to the next explanation.
    await next.click();
  }
  assert.deepEqual(
    heard,
    expected,
    'Every rule and example must pass through the active dialogue.',
  );
  return heard;
}
