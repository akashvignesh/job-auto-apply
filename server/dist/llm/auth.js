/**
 * CLAUDE_AUTH resolver — explicit auth-mode selection.
 *
 * The project supports exactly three Claude transports:
 *   CLAUDE_AUTH=api      Direct Anthropic API with ANTHROPIC_API_KEY
 *   CLAUDE_AUTH=oauth    Claude Code OAuth (~/.claude/.credentials.json + Keychain)
 *   CLAUDE_AUTH=bedrock  Amazon Bedrock via standard AWS credential chain + AWS_REGION
 *
 * No auto-detection. No fallback. If CLAUDE_AUTH is unset or its required
 * credentials are missing, resolveAuth() throws a clear error.
 */
import { getClaudeCredentials, getClaudeKeychainCredentials, } from "./credentials.js";
const VALID_MODES = new Set(["api", "oauth", "bedrock"]);
function readAuthMode() {
    const raw = process.env.CLAUDE_AUTH?.trim().toLowerCase();
    if (!raw) {
        throw new Error("CLAUDE_AUTH is not set. Choose one of: api, oauth, bedrock.\n" +
            "  api      → set ANTHROPIC_API_KEY\n" +
            "  oauth    → run `claude login` (uses ~/.claude/.credentials.json)\n" +
            "  bedrock  → set AWS_REGION and provide AWS credentials");
    }
    if (!VALID_MODES.has(raw)) {
        throw new Error(`CLAUDE_AUTH="${raw}" is invalid. Must be one of: api, oauth, bedrock.`);
    }
    return raw;
}
export function resolveAuth() {
    const mode = readAuthMode();
    if (mode === "api") {
        const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
        if (!apiKey) {
            throw new Error("CLAUDE_AUTH=api requires ANTHROPIC_API_KEY to be set.");
        }
        return { mode, apiKey };
    }
    if (mode === "oauth") {
        const credentials = getClaudeCredentials() || getClaudeKeychainCredentials();
        if (!credentials) {
            throw new Error("CLAUDE_AUTH=oauth requires Claude Code credentials. Run: claude login");
        }
        return { mode, credentials };
    }
    // bedrock
    const region = process.env.AWS_REGION?.trim();
    if (!region) {
        throw new Error("CLAUDE_AUTH=bedrock requires AWS_REGION to be set " +
            "(e.g. us-east-1). AWS credentials are resolved via the standard " +
            "AWS credential chain: env vars, ~/.aws/credentials, or IAM role.");
    }
    return { mode, region };
}
/** Human-readable description for startup logging. */
export function describeAuth(auth) {
    switch (auth.mode) {
        case "api":
            return "Anthropic API (ANTHROPIC_API_KEY)";
        case "oauth":
            return "Claude Code OAuth (~/.claude/.credentials.json)";
        case "bedrock":
            return `Amazon Bedrock (region=${auth.region})`;
    }
}
