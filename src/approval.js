const { createFixAndPR } = require('./github');
const { continueConversation } = require('./conversation');

/**
 * Handles all DM replies once a bug analysis is pending:
 * - APPROVE  → create branch + PR
 * - REJECT   → cancel and confirm
 * - anything else → conversational turn (clarifications, corrections, questions)
 */
async function handleApproval({ message, client, pendingApprovals }) {
  const channelId = message.channel;
  const pending = pendingApprovals.get(channelId);
  if (!pending) return;

  const text = (message.text || '').trim();
  const upper = text.toUpperCase();

  if (upper === 'APPROVE' || upper.startsWith('APPROVE ')) {
    pendingApprovals.delete(channelId);

    await client.chat.postMessage({
      channel: channelId,
      text: '⏳ Creating branch and applying fix — please wait...',
    });

    try {
      const prUrl = await createFixAndPR(pending);
      await client.chat.postMessage({
        channel: channelId,
        text: `✅ PR raised: ${prUrl}`,
      });
    } catch (err) {
      console.error('[approval] PR creation failed:', err);
      await client.chat.postMessage({
        channel: channelId,
        text: `❌ Failed to create PR: ${err.message}`,
      });
    }
  } else if (upper === 'REJECT' || upper.startsWith('REJECT ')) {
    const reason = text.slice(6).trim() || 'No reason given';
    pendingApprovals.delete(channelId);

    await client.chat.postMessage({
      channel: channelId,
      text: `🚫 Fix rejected. Reason: ${reason}\n\nNo changes will be made to \`${pending.repo}\`.`,
    });
  } else {
    // Conversational turn — clarifications, corrections, follow-up questions
    await continueConversation({
      userMessage: text,
      slackClient: client,
      channelId,
      pendingApprovals,
    });
  }
}

module.exports = { handleApproval };
