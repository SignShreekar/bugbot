require('dotenv').config();
const { App } = require('@slack/bolt');
const { handleBugReport, handleRepoSelection } = require('./listener');
const { handleApproval } = require('./approval');

// In-memory approval state keyed by DM channel ID
const pendingApprovals = new Map();

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  appToken: process.env.SLACK_APP_TOKEN,
  socketMode: true,
});

app.message(async ({ message, client }) => {
  if (message.subtype || message.bot_id) return;

  const text = message.text || '';
  const channelType = message.channel_type;
  const pending = pendingApprovals.get(message.channel);

  if (channelType === 'im') {
    if (!pending) return;

    if (pending.status === 'awaiting_repo') {
      // User replied to "which repo?" question
      await handleRepoSelection({ message, client, pendingApprovals });
    } else if (pending.status === 'verifying') {
      // User is in APPROVE/REJECT/conversation flow
      await handleApproval({ message, client, pendingApprovals });
    }
  } else {
    // Channel message — look for bug keyword + bot @mention
    const botUserId = process.env.SLACK_BOT_USER_ID;
    const hasBugKeyword = /\b(bug|issue|error)\b/i.test(text);
    const hasBotMention = text.includes(`<@${botUserId}>`);

    if (hasBugKeyword && hasBotMention) {
      await handleBugReport({ message, client, pendingApprovals });
    }
  }
});

(async () => {
  await app.start();
  console.log('⚡ BugBot is running in Socket Mode');
})();
