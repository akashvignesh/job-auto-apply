/**
 * Tool definitions for server-side managed agent loop.
 *
 * These mirror the extension's tool definitions but are used by the server
 * when driving the agent loop via Vertex AI. The extension receives
 * tool execution requests and returns results.
 */

import type { Tool } from "../llm/client.js";

export const AGENT_TOOLS: Tool[] = [
  {
    name: "read_page",
    description: `Read the current page in one of five modes. Default mode is "summary" — a compact ~1-2K view with the fields, buttons, errors, blocker, and next safe action. Use "full" only when you genuinely need the raw DOM tree. Refs only stay valid until the page changes — re-read after navigations.

Modes:
- summary       (DEFAULT) page meta + fields + buttons + errors + blocker + next safe action.
- actions                 interactive elements only ([ref] kind "label" state).
- errors                  validation errors and invalid fields — after a failed submit.
- form_summary            required-field fill state + submit button state.
- full                    raw DOM tree (the previous default).
- region                  subtree of a single ref (provide ref).

Screenshots are budgeted: <=2 per page-fingerprint and <=1 within ~1.5s.`,
    input_schema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["summary", "actions", "errors", "form_summary", "full", "region"],
          description: 'Output mode (default: "summary"). Use "full" only when summary/actions is insufficient.',
        },
        ref: {
          type: "string",
          description: 'Required when mode="region". The ref to scope output to.',
        },
        max_chars: {
          type: "number",
          description: 'Only applied to mode="full" or "region" (default: 20000).',
        },
        screenshot: {
          type: "boolean",
          description: "Include a screenshot. Subject to per-fingerprint budget.",
        },
      },
      required: [],
    },
  },
  {
    name: "find",
    description: `Find elements on the page using natural language. Can search by purpose (e.g., "search bar", "login button") or text content. Returns up to 20 matching elements with references.`,
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'Natural language description of what to find (e.g., "search bar", "add to cart button")',
        },
      },
      required: ["query"],
    },
  },
  {
    name: "form_input",
    description: `Set values in ANY form element — text inputs, textareas, dropdowns, checkboxes, radio buttons, date pickers. For dropdowns, just pass the desired option text. ALWAYS prefer form_input over computer clicks for form fields.`,
    input_schema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: 'Element reference from read_page (e.g., "42") or find tool (e.g., "ref_1")',
        },
        value: {
          type: "string",
          description: "The value to set.",
        },
      },
      required: ["ref", "value"],
    },
  },
  {
    name: "computer",
    description: `Use a mouse and keyboard to interact with a web browser, and take screenshots.
* Click elements using their ref from read_page or find tools.
* Take screenshots to see the current page state.
* Scroll to see more content.`,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "left_click", "right_click", "type", "screenshot", "wait",
            "scroll", "key", "left_click_drag", "double_click", "triple_click",
            "zoom", "scroll_to", "hover",
          ],
          description: "The action to perform.",
        },
        coordinate: {
          type: "array",
          items: { type: "number" },
          description: "(x, y) pixel coordinates for click/scroll actions.",
        },
        text: {
          type: "string",
          description: "Text to type or key(s) to press.",
        },
        duration: {
          type: "number",
          description: "Seconds to wait (for wait action). Max 30.",
        },
        scroll_direction: {
          type: "string",
          enum: ["up", "down", "left", "right"],
          description: "Direction to scroll.",
        },
        scroll_amount: {
          type: "number",
          description: "Number of scroll ticks (1-10).",
        },
        ref: {
          type: "string",
          description: "Element reference for click/scroll_to actions.",
        },
        region: {
          type: "array",
          items: { type: "number" },
          description: "(x0, y0, x1, y1) region for zoom action.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "navigate",
    description: `Navigate to a URL, or go forward/back in browser history.`,
    input_schema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: 'The URL to navigate to. Use "forward"/"back" for history navigation.',
        },
      },
      required: ["url"],
    },
  },
  {
    name: "get_page_text",
    description: `Extract raw text content from the page, prioritizing article content. Ideal for reading text-heavy pages.`,
    input_schema: {
      type: "object",
      properties: {
        max_chars: {
          type: "number",
          description: "Maximum characters for output (default: 50000).",
        },
      },
      required: [],
    },
  },
  {
    name: "javascript_tool",
    description: `Execute JavaScript in the page context. Returns the result of the last expression. Do NOT use 'return' — just write the expression.`,
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          description: "Must be 'javascript_exec'.",
        },
        text: {
          type: "string",
          description: "JavaScript code to execute.",
        },
      },
      required: ["action", "text"],
    },
  },
  {
    name: "file_upload",
    description: `Upload a file to a file input element on the page. Use this for resume/CV and cover letter uploads — NEVER click the file input directly. Resolves shadow DOM and iframes automatically.`,
    input_schema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "Element reference for the file input from read_page.",
        },
        filePath: {
          type: "string",
          description: "Absolute or relative path to the file to upload.",
        },
      },
      required: ["ref", "filePath"],
    },
  },
  // Phase B — Webwright-inspired tools (mirrored in src/tools/definitions.js).
  {
    name: "run_script",
    description: `Execute MULTIPLE action steps in ONE tool call. Prefer this whenever you have ≥3 form_input or click steps planned with no read_page between them. Each action is {tool, input} where tool ∈ {form_input, computer, file_upload, navigate}. Results are reported per-action.`,
    input_schema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              tool: { type: "string" },
              input: { type: "object" },
            },
            required: ["tool", "input"],
          },
        },
        stopOnError: { type: "boolean" },
      },
      required: ["actions"],
    },
  },
  {
    name: "verify_action",
    description: `Cheap CDP-based check that an action actually changed the page (URL changed, text appeared, ref disappeared, modal appeared). Use after Submit / Save and Continue / navigations instead of a full read_page when you only need yes/no.`,
    input_schema: {
      type: "object",
      properties: {
        expect: {
          type: "string",
          enum: ["navigated", "text-appeared", "ref-disappeared", "modal-present"],
        },
        hint: { type: "string" },
        timeoutMs: { type: "number" },
        tabId: { type: "number" },
      },
      required: ["expect"],
    },
  },
];
