#!/usr/bin/env node
import { createOrAttachTarget, CdpSession } from "file:///D:/Code/Git/job_apply/job-auto-apply/server/dist/local-runner/cdp.js";
import { LocalBrowser } from "file:///D:/Code/Git/job_apply/job-auto-apply/server/dist/local-runner/browser.js";

const actions = [
  {
    "name": "navigate",
    "input": {
      "url": "https://workday.wd5.myworkdayjobs.com/en-US/Workday/details/Senior-Software-Development-Engineer_JR-0107127"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "wait",
      "duration": 3
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "46"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "wait",
      "duration": 3
    }
  },
  {
    "name": "verify_action",
    "input": {
      "expect": "navigated",
      "hint": "Check if Apply button navigated to application form"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "57"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "wait",
      "duration": 3
    }
  },
  {
    "name": "verify_action",
    "input": {
      "expect": "navigated",
      "hint": "Check if Autofill with Resume navigated to application form"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "11"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "wait",
      "duration": 1
    }
  },
  {
    "name": "javascript_tool",
    "input": {
      "action": "javascript_exec",
      "text": "document.querySelectorAll('input[type=\"file\"]').length"
    }
  },
  {
    "name": "javascript_tool",
    "input": {
      "action": "javascript_exec",
      "text": "document.querySelector('input[type=\"file\"]')"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "12"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "wait",
      "duration": 2
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        640,
        400
      ],
      "scroll_direction": "up",
      "scroll_amount": 5
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        415,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "17",
      "value": "LinkedIn"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "17"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "17",
      "value": "LinkedIn"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        415,
        560
      ],
      "scroll_direction": "down",
      "scroll_amount": 3
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        640,
        400
      ],
      "scroll_direction": "up",
      "scroll_amount": 5
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        256,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        227,
        621
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        227,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        415,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        227,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "triple_click",
      "coordinate": [
        415,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        609,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        640,
        700
      ],
      "scroll_direction": "down",
      "scroll_amount": 3
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        640,
        400
      ],
      "scroll_direction": "up",
      "scroll_amount": 5
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        227,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        400,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        227,
        571
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "17"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "type",
      "text": "LinkedIn"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "17",
      "value": "LinkedIn"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        256,
        440
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        607,
        440
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        227,
        393
      ]
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "17",
      "value": "LinkedIn"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "17"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "type",
      "text": "LinkedIn"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "key",
      "text": "LinkedI"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        414,
        600
      ],
      "scroll_direction": "down",
      "scroll_amount": 3
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        640,
        400
      ],
      "scroll_direction": "up",
      "scroll_amount": 5
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "scroll",
      "coordinate": [
        414,
        700
      ],
      "scroll_direction": "down",
      "scroll_amount": 2
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  }
];
const debugPortArg = process.argv.find((x) => x.startsWith("--debug-port="));
const debugPort = debugPortArg ? Number(debugPortArg.split("=")[1]) : 9222;
const startUrl = process.argv.find((x) => /^https?:\/\//i.test(x)) || "https://workday.wd5.myworkdayjobs.com/en-US/Workday/details/Senior-Software-Development-Engineer_JR-0107127";

const target = await createOrAttachTarget(debugPort, startUrl || undefined);
const cdp = new CdpSession(target.webSocketDebuggerUrl);
const browser = new LocalBrowser(cdp);
await browser.init();

for (const [i, action] of actions.entries()) {
  const result = await browser.executeTool(action.name, action.input || {});
  console.log(`[${result.success ? "OK" : "FAIL"}] #${i + 1} ${action.name}: ${result.error || result.output || ""}`);
  if (!result.success) process.exitCode = 1;
}

cdp.close();
