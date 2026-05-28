/**
 * ScreenshotContextManager - Manages screenshot context for coordinate scaling
 * Stores viewport/screenshot dimensions per tab for DPR coordinate scaling
 */

class ScreenshotContextManager {
  contexts = new Map();

  /**
   * Store screenshot context for a tab
   * @param {number} tabId - The tab ID
   * @param {Object} screenshotResult - Result from screenshot operation
   */
  setContext(tabId, screenshotResult) {
    if (screenshotResult.viewportWidth && screenshotResult.viewportHeight) {
      const context = {
        viewportWidth: screenshotResult.viewportWidth,
        viewportHeight: screenshotResult.viewportHeight,
        screenshotWidth: screenshotResult.width,
        screenshotHeight: screenshotResult.height,
      };
      this.contexts.set(tabId, context);
    }
  }

  /**
   * Get screenshot context for a tab
   * @param {number} tabId - The tab ID
   * @returns {Object|undefined} The context or undefined
   */
  getContext(tabId) {
    return this.contexts.get(tabId);
  }

  /**
   * Clear context for a specific tab
   * @param {number} tabId - The tab ID
   */
  clearContext(tabId) {
    this.contexts.delete(tabId);
  }

  /**
   * Clear all stored contexts
   */
  clearAllContexts() {
    this.contexts.clear();
  }
}

// Singleton instance
export const screenshotContextManager = new ScreenshotContextManager();

// Also export the class for testing
export { ScreenshotContextManager };

/**
 * Scale coordinates from screenshot space to viewport space
 * Scale coordinates based on DPR
 *
 * @param {number} x - X coordinate in screenshot space
 * @param {number} y - Y coordinate in screenshot space
 * @param {Object} context - Screenshot context with viewport/screenshot dimensions
 * @returns {[number, number]} Scaled [x, y] coordinates
 */
export function scaleCoordinates(x, y, context) {
  const scaleX = context.viewportWidth / context.screenshotWidth;
  const scaleY = context.viewportHeight / context.screenshotHeight;
  return [x * scaleX, y * scaleY];
}

/**
 * Live-scale coordinates from screenshot space to the CURRENT viewport space.
 *
 * Unlike scaleCoordinates(), this fetches fresh viewport dimensions right before
 * the click so that window resizes after the screenshot do not cause drift.
 *
 * @param {number} x - X coordinate in screenshot space
 * @param {number} y - Y coordinate in screenshot space
 * @param {Object} context - Screenshot context (screenshotWidth/Height are still valid)
 * @param {(method: string, params?: Object) => Promise<*>} cdp - CDP command sender
 * @returns {Promise<[number, number]>} Scaled [x, y] coordinates in current viewport space
 */
export async function scaleCoordinatesLive(x, y, context, cdp) {
  try {
    const res = await cdp('Runtime.evaluate', {
      expression: '[window.innerWidth, window.innerHeight]',
      returnByValue: true,
    });
    const value = res?.result?.value;
    if (Array.isArray(value) && value.length === 2 && value[0] > 0 && value[1] > 0) {
      const [currentW, currentH] = value;
      const scaleX = currentW / context.screenshotWidth;
      const scaleY = currentH / context.screenshotHeight;
      return [Math.round(x * scaleX), Math.round(y * scaleY)];
    }
  } catch (_) {
    // CDP failed (e.g., debugger not attached) — fall through to static scaling
  }
  // Fallback: use the stale viewport dims recorded at screenshot time
  return scaleCoordinates(x, y, context);
}
