/**
 * System prompt builder for the server-side agent loop.
 *
 * Accepts an optional profile object (loaded from profile/profile.json) and
 * injects it as <applicant_profile> and <applicant_preferences> blocks.
 * When no profile is provided the agent still works but will need profile
 * data in the task context instead.
 */
export declare function buildSystemPrompt(taskUrl?: string, profile?: Record<string, any>): Array<{
    type: "text";
    text: string;
    cache_control?: {
        type: "ephemeral";
    };
}>;
