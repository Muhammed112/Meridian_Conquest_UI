import { existsSync } from 'node:fs';
import { chromium as browserType } from 'playwright';

// CI uses Playwright's pinned browser. Developers can also use an installed
// Chrome, or select a browser explicitly without editing any test scripts.
export const chromium = {
  /** Prefer the configured executable, then the pinned browser, then an installed Chrome. */
  async launch(options = {}) {
    const executablePath = process.env.MERIDIAN_BROWSER_PATH;
    if (executablePath) return browserType.launch({ ...options, executablePath });
    if (existsSync(browserType.executablePath())) return browserType.launch(options);
    try {
      return await browserType.launch({ ...options, channel: 'chrome' });
    } catch (cause) {
      throw new Error('Install the test browser with npm run browsers:install.', { cause });
    }
  },
};
