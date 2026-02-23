const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();
const MAX_TURNS = 3;

/**
 * Continues a multi-turn DM conversation about the bug analysis.
 * Enforces a maximum of MAX_TURNS clarification rounds.
 */
async function continueConversation({ userMessage, slackClient, channelId, pendingApprovals }) {
  const pending = pendingApprovals.get(channelId);
  if (!pending) return;

  pending.clarificationTurns = (pending.clarificationTurns || 0) + 1;
  const turnsLeft = MAX_TURNS - pending.clarificationTurns;

  // Add user message to history
  pending.conversationHistory.push({ role: 'user', content: userMessage });

  const systemPrompt = `You are BugBot, an expert bug analysis assistant in Slack. You analyzed a bug and produced this finding:

Priority: ${pending.priority}
Repo: ${pending.repo}
RCA: ${pending.rca}
Affected files: ${pending.affectedFiles.join(', ')}
Fix plan: ${pending.fixPlan}
Risk: ${pending.risk}

Your role in this conversation:
1. Answer questions about the analysis clearly and concisely
2. Accept corrections — acknowledge and update your understanding
3. Ask targeted clarifying questions if you need more context
4. Keep replies brief — this is a Slack DM

Do NOT use markdown formatting. Plain text only.
${turnsLeft === 0 ? 'This is the final clarification turn. After your response, prompt the user to APPROVE or REJECT.' : ''}`;

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    system: systemPrompt,
    messages: pending.conversationHistory,
  });

  const response = await stream.finalMessage();
  let replyText = response.content[0].text.trim();

  // Append APPROVE/REJECT reminder on final turn
  if (turnsLeft === 0) {
    replyText += '\n\nThat\'s the maximum clarifications for this session. Reply APPROVE to raise a PR, or REJECT <reason> to cancel.';
  }

  pending.conversationHistory.push({ role: 'assistant', content: replyText });

  // Refresh structured analysis if user provided corrections
  const isCorrecting = /wrong|incorrect|actually|not right|should be|missing|also|update|change|no,|nope|different/i.test(userMessage);
  if (isCorrecting) {
    await refreshAnalysis(pending);
  }

  await slackClient.chat.postMessage({ channel: channelId, text: replyText });
}

/**
 * Re-extracts structured fields from the conversation when the user corrects something.
 */
async function refreshAnalysis(pending) {
  const historyStr = pending.conversationHistory
    .map((m) => `${m.role === 'user' ? 'User' : 'BugBot'}: ${m.content}`)
    .join('\n\n');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    messages: [
      {
        role: 'user',
        content: `Based on this conversation, extract any updates to the bug analysis fields.

Original:
Priority: ${pending.priority}
RCA: ${pending.rca}
Affected files: ${pending.affectedFiles.join(', ')}
Fix plan: ${pending.fixPlan}
Risk: ${pending.risk}

Conversation:
${historyStr}

Return JSON with only the fields that changed (omit unchanged fields). Return {} if nothing changed:
{
  "priority": "P1",
  "rca": "updated rca",
  "affectedFiles": ["file:line"],
  "fixPlan": "updated steps",
  "risk": "Low"
}`,
      },
    ],
  });

  const response = await stream.finalMessage();
  const text = response.content[0].text.trim();

  try {
    const updates = JSON.parse(text);
    if (Object.keys(updates).length > 0) {
      Object.assign(pending, updates);
      console.log('[conversation] analysis updated:', updates);
    }
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        const updates = JSON.parse(match[0]);
        if (Object.keys(updates).length > 0) Object.assign(pending, updates);
      } catch { /* keep existing */ }
    }
  }
}

module.exports = { continueConversation };
