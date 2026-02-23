require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { App } = require('@slack/bolt');
const { handleBugReport, handleRepoSelection } = require('./listener');
const { handleApproval } = require('./approval');

// In-memory approval state keyed by DM channel ID
const pendingApprovals = new Map();

// File-based logger
const LOG_DIR = path.join(__dirname, '..', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'bugbot.log');

function log(level, message) {
  const entry = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(entry);
  fs.appendFileSync(LOG_FILE, entry + '\n');
}

// Crash recovery — log and restart the process on fatal errors
process.on('uncaughtException', (err) => {
  log('FATAL', `Uncaught exception: ${err.message}\n${err.stack}`);
  log('INFO', 'Restarting process in 3 seconds...');
  setTimeout(() => process.exit(1), 3000);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled promise rejection: ${reason instanceof Error ? reason.stack : reason}`);
});

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
  log('INFO', '⚡ BugBot is running in Socket Mode');
  log('INFO', `Logs writing to: ${LOG_FILE}`);
})();
