#!/usr/bin/env node
/**
 * Local runner CLI — runs the agent loop against a Chrome instance with
 * remote debugging enabled.
 *
 * Usage:
 *   node dist/local-runner/cli.js --task "apply to job" --url "https://..."
 *
 * Chrome must be running with:
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\\Code\\Git\\job_apply\\chrome-local-agent"
 *
 * Profile separation:
 *   --profile <path>   Path to profile.json (default: ./profile/profile.json)
 *                      Different users only change this file; patterns are shared.
 *
 * Pattern store:
 *   --patterns <dir>   Directory for filesystem patterns (default: ./patterns)
 *                      Patterns accumulate across runs; committed alongside code.
 */
export {};
