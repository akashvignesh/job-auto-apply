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
import { type ClaudeCredentials } from "./credentials.js";
export type AuthMode = "api" | "oauth" | "bedrock";
export type AuthConfig = {
    mode: "api";
    apiKey: string;
} | {
    mode: "oauth";
    credentials: ClaudeCredentials;
} | {
    mode: "bedrock";
    region: string;
};
export declare function resolveAuth(): AuthConfig;
/** Human-readable description for startup logging. */
export declare function describeAuth(auth: AuthConfig): string;
