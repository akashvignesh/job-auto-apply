/**
 * Form tool handlers
 * Handles: form_input, file_upload
 * Phase 6: Grounding validation for form inputs
 */

import { ensureDebugger, sendDebuggerCommand } from '../managers/debugger-manager.js';
import { PROFILE_FOLDER } from '../modules/profile-path.js';

const NATIVE_HOST_NAME = 'com.hanzi_browse.oauth_host';

/**
 * Check if a file exists on disk via native messaging bridge.
 * CDP virtualizes file references, so FileReader can't detect missing files.
 * The native host (Node.js) uses fs.existsSync for a reliable check.
 * @param {string} filePath - Absolute file path to check
 * @returns {Promise<boolean>} True if file exists
 */
async function checkFileExists(filePath) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendNativeMessage(
        NATIVE_HOST_NAME,
        { type: 'check_file', filePath },
        (response) => {
          if (chrome.runtime.lastError) {
            // Native host unavailable — can't verify, allow attempt
            resolve(true);
            return;
          }
          resolve(response?.exists ?? false);
        }
      );
    } catch (e) {
      // Native messaging not available — allow attempt
      resolve(true);
    }
  });
}

// Profile folder path imported from build-generated config

// Cached downloads folder path (detected lazily from chrome.downloads history)
let _downloadsFolder = null;

/**
 * Detect the user's downloads folder from chrome.downloads history.
 * Looks for a past download from our extension (browser-agent/ subfolder)
 * and extracts the base downloads directory from the full path.
 * @returns {Promise<string|null>} Downloads folder path or null if undetectable
 */
async function getDownloadsFolder() {
  if (_downloadsFolder) return _downloadsFolder;

  try {
    // Check if we have a stored value
    const stored = await chrome.storage.local.get('downloadsFolder');
    if (stored.downloadsFolder) {
      _downloadsFolder = stored.downloadsFolder;
      return _downloadsFolder;
    }

    // Detect from a past download made by our extension
    const [item] = await chrome.downloads.search({
      filenameRegex: 'browser-agent',
      limit: 1,
      orderBy: ['-startTime'],
    });

    if (item?.filename) {
      const idx = item.filename.indexOf('browser-agent');
      if (idx > 0) {
        _downloadsFolder = item.filename.substring(0, idx);
        await chrome.storage.local.set({ downloadsFolder: _downloadsFolder });
        return _downloadsFolder;
      }
    }
  } catch (e) {
    // Silent fail — will use filePath as-is
  }

  return null;
}

/**
 * Resolve a file path:
 * - "profile/resume.pdf" → resolves against PROFILE_FOLDER (build-time constant)
 * - "resume.pdf" (bare filename) → resolves against downloads folder
 * - "/absolute/path/file.pdf" → used as-is
 * @param {string} input - File path or bare filename
 * @returns {Promise<string>} Resolved absolute file path
 */
async function resolveFilePath(input) {
  // Absolute path — use as-is
  if (input.startsWith('/') || input.startsWith('~') || /^[A-Z]:\\/.test(input)) {
    return input;
  }

  // Relative path starting with "profile/" — resolve against PROFILE_FOLDER
  if (input.startsWith('profile/') || input.startsWith('profile\\')) {
    if (PROFILE_FOLDER) {
      const fileName = input.replace(/^profile[/\\]/, '');
      return PROFILE_FOLDER.endsWith('/') ? PROFILE_FOLDER + fileName : PROFILE_FOLDER + '/' + fileName;
    }
  }

  // Contains path separator but not "profile/" — return as-is
  if (input.includes('/') || input.includes('\\')) {
    return input;
  }

  // Bare filename — resolve against downloads folder
  const downloadsDir = await getDownloadsFolder();
  if (downloadsDir) {
    return downloadsDir + input;
  }

  // Can't resolve — return as-is
  return input;
}

/**
 * @typedef {Object} FormToolDeps
 * @property {Function} sendToContent - Send message to content script
 * @property {Function} log - Logging function
 */

/**
 * Handle form_input tool - fill form fields with values
 * @param {Object} toolInput - Tool input parameters
 * @param {number} toolInput.tabId - Tab ID containing the form
 * @param {string} toolInput.ref - Element reference from accessibility tree
 * @param {string} toolInput.value - Value to set in the form field
 * @param {FormToolDeps} deps - Dependency injection object
 * @returns {Promise<string>} Success message or error
 */
export async function handleFormInput(toolInput, deps) {
  const { tabId } = toolInput;
  const { sendToContent } = deps;

  // Phase 6: Grounding validation — log if value might not be in profile
  const log = deps?.log || console.log;
  if (typeof toolInput.value === 'string' && toolInput.value.length > 3) {
    // Non-blocking logging: warn if value looks fabricated
    // This is informational only and doesn't block the action
    if (toolInput.value.match(/^(test|demo|sample|example|fake|placeholder)/i)) {
      log?.('[GROUNDING]', `form_input value may be fabricated: "${toolInput.value.slice(0, 40)}"`);
    }
  }

  const result = await sendToContent(tabId, 'FORM_INPUT', {
    ref: toolInput.ref,
    value: toolInput.value,
  });
  return result.success ? (result.output || 'Value set successfully') : `Error: ${result.error}`;
}

/**
 * Handle file_upload tool - upload files to file input elements using CDP
 *
 * Uses Chrome DevTools Protocol DOM.setFileInputFiles for reliable uploads.
 * Just provide a local file path - CDP handles the rest.
 *
 * @param {Object} toolInput - Tool input parameters
 * @param {number} toolInput.tabId - Tab ID containing the file input
 * @param {string} [toolInput.ref] - Element reference from accessibility tree (e.g., "ref_123")
 * @param {string} [toolInput.selector] - CSS selector for file input (used if ref not provided)
 * @param {string} toolInput.filePath - Absolute path to local file (e.g., "/Users/name/resume.pdf")
 * @param {FormToolDeps} deps - Dependency injection object
 * @returns {Promise<string>} Success message or error
 */
export async function handleFileUpload(toolInput, deps) {
  const { tabId, ref, selector } = toolInput;
  // Support both filePath and file_path (LLM might use either)
  const rawFilePath = toolInput.filePath || toolInput.file_path;
  const log = deps?.log || console.log;

  // Validate inputs
  if (!ref && !selector) {
    return 'Error: Either ref or selector is required to identify the file input element';
  }
  if (!rawFilePath) {
    return 'Error: filePath is required (file name or absolute path to the file)';
  }

  // Resolve bare filenames against the downloads folder
  const filePath = await resolveFilePath(rawFilePath);
  if (filePath !== rawFilePath) {
    await log?.('FILE_UPLOAD', `Resolved "${rawFilePath}" → "${filePath}"`);
  }

  try {
    // Ensure debugger is attached
    const attached = await ensureDebugger(tabId);
    if (!attached) {
      return 'Error: Could not attach debugger to tab';
    }

    // Find the file input element.
    //
    // read_page refs are CDP backendNodeIds — they are GLOBAL and pierce shadow DOM and
    // iframes. Resolve those first via pushNodesByBackendIdsToFrontend. The old code only
    // tried CSS selectors (#ref, [data-ref], input[type=file]) against the document root,
    // and DOM.querySelector cannot reach inputs inside shadow roots — which is exactly why
    // iCIMS/Workday resume uploads failed repeatedly.
    let nodeId;
    const selectorToUse = selector || `input[type="file"]`;
    const numericRef = ref != null && /^\d+$/.test(String(ref)) ? parseInt(String(ref), 10) : null;

    if (numericRef != null) {
      try {
        const pushed = await sendDebuggerCommand(tabId, 'DOM.pushNodesByBackendIdsToFrontend', {
          backendNodeIds: [numericRef],
        });
        if (pushed?.nodeIds?.[0]) {
          nodeId = pushed.nodeIds[0];
          await log?.('FILE_UPLOAD', `Resolved ref ${numericRef} via backendNodeId (shadow-DOM safe)`);
        }
      } catch (e) {
        // fall through to selector resolution
      }
    }

    // Selector fallback (top-level inputs only; will not reach shadow DOM).
    if (!nodeId) {
      const { root } = await sendDebuggerCommand(tabId, 'DOM.getDocument', {});
      if (ref && numericRef == null) {
        for (const refSelector of [`[data-llm-ref="${ref}"]`, `[data-ref="${ref}"]`, `#${ref}`]) {
          try {
            const result = await sendDebuggerCommand(tabId, 'DOM.querySelector', {
              nodeId: root.nodeId,
              selector: refSelector,
            });
            if (result.nodeId && result.nodeId !== 0) { nodeId = result.nodeId; break; }
          } catch (e) { /* try next */ }
        }
      }
      if (!nodeId) {
        const result = await sendDebuggerCommand(tabId, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector: selectorToUse,
        });
        nodeId = result.nodeId;
      }
    }

    if (!nodeId || nodeId === 0) {
      const identifier = ref ? 'ref="' + ref + '"' : 'selector="' + selectorToUse + '"';
      return 'Error: Could not find file input element with ' + identifier;
    }

    // Check if it's a file input, if not search children
    let fileInputNodeId = nodeId;
    try {
      const { node } = await sendDebuggerCommand(tabId, 'DOM.describeNode', { nodeId });

      const isFileInput = node.nodeName === 'INPUT' &&
        node.attributes &&
        node.attributes.includes('type') &&
        node.attributes[node.attributes.indexOf('type') + 1] === 'file';

      if (!isFileInput) {
        // Search for file input in children
        const childResult = await sendDebuggerCommand(tabId, 'DOM.querySelector', {
          nodeId: nodeId,
          selector: 'input[type="file"]'
        });
        if (childResult.nodeId && childResult.nodeId !== 0) {
          fileInputNodeId = childResult.nodeId;
          await log?.('FILE_UPLOAD', 'Found file input in children');
        }
      }
    } catch (e) {
      // Continue with original node
    }

    // Verify file exists on disk before setting it.
    // CDP silently accepts nonexistent paths and even FileReader passes
    // (Chrome virtualizes the file reference). Only the native host can reliably check.
    const fileExists = await checkFileExists(filePath);
    if (!fileExists) {
      return `Error: File "${filePath}" does not exist or is not readable. Check the path and try again.`;
    }

    // Set files on the input using CDP
    await sendDebuggerCommand(tabId, 'DOM.setFileInputFiles', {
      nodeId: fileInputNodeId,
      files: [filePath]
    });

    // Trigger change event via the resolved node
    try {
      const { object: triggerObj } = await sendDebuggerCommand(tabId, 'DOM.resolveNode', {
        nodeId: fileInputNodeId,
      });
      await sendDebuggerCommand(tabId, 'Runtime.callFunctionOn', {
        objectId: triggerObj.objectId,
        functionDeclaration: `
          function() {
            this.dispatchEvent(new Event('change', { bubbles: true }));
            this.dispatchEvent(new Event('input', { bubbles: true }));
          }
        `,
      });
    } catch (triggerErr) {
      await log?.('FILE_UPLOAD', `Event trigger failed (non-fatal): ${triggerErr.message}`);
    }

    const uploadedFileName = filePath.split('/').pop();
    return `Successfully uploaded "${uploadedFileName}" to file input`;

  } catch (err) {
    return `Error uploading file: ${err.message}`;
  }
}
