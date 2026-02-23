const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

/**
 * Classifies a bug report as P0–P3 using Claude.
 * @param {string} messageText - Raw Slack message text
 * @returns {{ priority: string, reasoning: string }}
 */
async function triageBug(messageText) {
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `You are a bug triage specialist. Classify this bug report by severity.

Bug report:
"${messageText}"

Priority guidelines:
- P0: System down, data loss, security breach — immediate action required
- P1: Critical feature broken, many users impacted
- P2: Important feature degraded, workaround exists
- P3: Minor issue, cosmetic, low impact

Respond with JSON only (no markdown fences, no explanation):
{
  "priority": "P1",
  "reasoning": "one sentence explaining the classification"
}`,
      },
    ],
  });

  const response = await stream.finalMessage();
  const text = response.content[0].text.trim();

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Could not parse triage response: ${text}`);
  }
}

module.exports = { triageBug };
