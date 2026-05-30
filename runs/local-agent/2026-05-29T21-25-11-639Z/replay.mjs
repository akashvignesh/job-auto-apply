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
      "action": "left_click",
      "ref": "44"
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
      "ref": "55"
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
      "action": "screenshot"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "17",
      "value": "akashsureshkumar.dev@gmail.com"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "18",
      "value": "Akash@2001"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "20"
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
      "ref": "21"
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
      "action": "screenshot"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "24",
      "value": "akashsureshkumar.dev@gmail.com"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "25",
      "value": "Akash@2001"
    }
  },
  {
    "name": "form_input",
    "input": {
      "ref": "26",
      "value": "Akash@2001"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "28"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "30"
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
      "action": "scroll",
      "coordinate": [
        640,
        400
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
      "action": "left_click",
      "ref": "30"
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
      "action": "left_click",
      "ref": "4"
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
      "ref": "38"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
    }
  },
  {
    "name": "run_script",
    "input": {
      "actions": [
        {
          "tool": "form_input",
          "input": {
            "ref": "39",
            "value": "akashsureshkumar.dev@gmail.com"
          }
        },
        {
          "tool": "form_input",
          "input": {
            "ref": "40",
            "value": "Akash@2001"
          }
        }
      ]
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "42"
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
      "action": "wait",
      "duration": 2
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "ref": "41"
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
      "ref": "11"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "screenshot"
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
      "text": "\n// Get the file input element\nconst fileInput = document.querySelector('input[type=\"file\"]');\nif (fileInput) {\n  fileInput.value;\n} else {\n  'No file input found'\n}\n"
    }
  },
  {
    "name": "computer",
    "input": {
      "action": "left_click",
      "coordinate": [
        646,
        439
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
      "action": "left_click",
      "ref": "17"
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
