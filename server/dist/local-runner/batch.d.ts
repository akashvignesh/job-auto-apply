#!/usr/bin/env node
/**
 * Batch runner — drives N tasks against N Chrome targets in parallel.
 *
 * Each worker:
 *   - attaches to a separate Chrome remote-debug port (--base-port + workerIdx)
 *   - runs the full agent loop (same code path as cli.ts)
 *   - writes its own run dir under <runs-dir>/<stamp>/
 *   - logs results to <runs-dir>/batch-results.jsonl
 *
 * Shared across workers:
 *   - PagePatternStore on disk (concurrent writes are append-or-replace safe;
 *     the same filename is rewritten atomically per pattern key)
 *   - Profile JSON (read-only)
 *
 * Usage:
 *   node server/dist/local-runner/batch.js \
 *     --jobs ./jobs.jsonl \
 *     --concurrency 3 \
 *     --base-port 9222 \
 *     --runs-dir ./runs/batch \
 *     --profile ./profile/profile.json \
 *     --patterns ./patterns \
 *     --max-steps 80
 *
 * Each line of jobs.jsonl is JSON: { "task": "...", "url": "...", "context"?: "...", "maxSteps"?: 60 }
 *
 * Chrome setup (one per concurrency slot):
 *   chrome.exe --remote-debugging-port=9222 --user-data-dir="D:\…\chrome-batch-0"
 *   chrome.exe --remote-debugging-port=9223 --user-data-dir="D:\…\chrome-batch-1"
 *   chrome.exe --remote-debugging-port=9224 --user-data-dir="D:\…\chrome-batch-2"
 */
export {};
