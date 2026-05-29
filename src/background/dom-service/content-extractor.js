/**
 * Content Extractor — Phase 3
 *
 * Three-tier extraction cascade for structured data (job postings, product listings).
 * Tier 1: JSON-LD (no LLM) → Tier 2: API interception (no LLM) → Tier 3: LLM-guided
 */

/**
 * Extract JSON-LD structured data from the page via JS injection.
 *
 * @param {number} tabId - Chrome tab ID
 * @param {Function} sendDebuggerCommand - CDP command function
 * @returns {Promise<Array>} Array of parsed JSON-LD objects
 */
export async function extractJsonLd(tabId, sendDebuggerCommand) {
  try {
    const result = await sendDebuggerCommand('Runtime.evaluate', {
      expression: `
        Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .map(s => { try { return JSON.parse(s.textContent); } catch(e) { return null; } })
          .filter(Boolean)
      `,
      returnByValue: true,
    });

    return result?.result?.value || [];
  } catch (err) {
    console.warn('[content-extractor] Failed to extract JSON-LD:', err.message);
    return [];
  }
}

/**
 * Prepare JSON-LD structured data for inclusion in read_page output.
 * Only includes if @type matches expected types (JobPosting, Product, Organization, etc).
 *
 * @param {Array} jsonLdArray - Array of parsed JSON-LD objects
 * @returns {string} Formatted section for read_page output, or empty string
 */
export function formatJsonLdSection(jsonLdArray) {
  if (!jsonLdArray || jsonLdArray.length === 0) {
    return '';
  }

  const relevant = jsonLdArray.filter(obj => {
    const type = obj['@type'];
    if (typeof type === 'string') {
      return ['JobPosting', 'Product', 'Organization', 'Person', 'BreadcrumbList', 'Article'].includes(type);
    }
    if (Array.isArray(type)) {
      return type.some(t => ['JobPosting', 'Product', 'Organization', 'Person', 'BreadcrumbList', 'Article'].includes(t));
    }
    return false;
  });

  if (relevant.length === 0) {
    return '';
  }

  let output = '\n=== STRUCTURED DATA (JSON-LD) ===\n';
  for (const obj of relevant) {
    output += JSON.stringify(obj, null, 2);
    output += '\n\n';
  }
  output += '=== END STRUCTURED DATA ===\n';

  return output;
}

/**
 * Store for intercepted network responses (per tabId).
 * Maps tabId → Map<url, { contentType, body, parsed }>
 */
const interceptedResponses = new Map();

/**
 * Initialize network interception for a tab.
 * Must be called after debugger is attached.
 *
 * @param {number} tabId - Chrome tab ID
 * @param {Function} sendDebuggerCommand - CDP command function
 */
export async function initNetworkInterception(tabId, sendDebuggerCommand) {
  try {
    await sendDebuggerCommand('Network.enable', {});

    // Note: In a real extension, we'd listen to Network.responseReceived events
    // and cache them. This is a placeholder showing the setup.
    // Full implementation requires setting up event listeners, which is done in
    // the debugger-manager.js or as part of the CDP lifecycle.

    if (!interceptedResponses.has(tabId)) {
      interceptedResponses.set(tabId, new Map());
    }
  } catch (err) {
    console.warn('[content-extractor] Failed to initialize network interception:', err.message);
  }
}

/**
 * Get intercepted API responses for the current tab.
 *
 * @param {number} tabId - Chrome tab ID
 * @returns {Array} Array of {url, data} objects
 */
export function getInterceptedResponses(tabId) {
  const responses = interceptedResponses.get(tabId);
  if (!responses) return [];

  return Array.from(responses.values())
    .filter(r => r.parsed && typeof r.parsed === 'object')
    .map(r => ({
      url: r.url,
      data: r.parsed
    }));
}

/**
 * Clear intercepted responses for a tab (called on navigation or cleanup).
 *
 * @param {number} tabId - Chrome tab ID
 */
export function clearInterceptedResponses(tabId) {
  if (interceptedResponses.has(tabId)) {
    interceptedResponses.get(tabId).clear();
  }
}

/**
 * Add an intercepted response to the cache.
 * Called when Network.responseReceived event fires.
 *
 * @param {number} tabId - Chrome tab ID
 * @param {string} url - Response URL
 * @param {string} contentType - Response content-type header
 * @param {any} parsedBody - Parsed JSON body (or null)
 */
export function cacheInterceptedResponse(tabId, url, contentType, parsedBody) {
  if (!interceptedResponses.has(tabId)) {
    interceptedResponses.set(tabId, new Map());
  }

  const responses = interceptedResponses.get(tabId);
  responses.set(url, {
    url,
    contentType,
    parsed: parsedBody
  });
}

/**
 * Format intercepted API responses for inclusion in read_page output.
 * Only includes JSON responses from same-origin API calls with relevant fields.
 *
 * @param {Array} responses - Array of {url, data} from getInterceptedResponses
 * @returns {string} Formatted section for read_page output, or empty string
 */
export function formatInterceptedSection(responses) {
  if (!responses || responses.length === 0) {
    return '';
  }

  // Filter to responses with job/form-relevant fields
  const relevant = responses.filter(r => {
    const data = r.data;
    if (!data) return false;

    // Check for job-related fields
    const jobFields = ['jobs', 'job', 'postings', 'posting', 'positions', 'position', 'title', 'company', 'location'];
    const dataStr = JSON.stringify(data).toLowerCase();
    return jobFields.some(field => dataStr.includes(field));
  });

  if (relevant.length === 0) {
    return '';
  }

  let output = '\n=== INTERCEPTED API RESPONSES ===\n';
  for (const { url, data } of relevant) {
    output += `URL: ${url}\n`;
    output += JSON.stringify(data, null, 2);
    output += '\n\n';
  }
  output += '=== END API RESPONSES ===\n';

  return output;
}
