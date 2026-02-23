const { triageBug } = require('./triage');
const { discoverRepo, getRepoList, extractRepoFromText } = require('./repoDiscovery');
const { scanCode } = require('./codeScan');

const MAX_CLARIFICATION_TURNS = 3;

/**
 * Phase 1 — triggered when a bug is mentioned in a channel.
 * Asks the user which codebase(s) to focus on (optional), then waits.
 */
async function handleBugReport({ message, client, pendingApprovals }) {
  const myUserId = process.env.YOUR_SLACK_USER_ID;
  if (message.user !== myUserId) return;

  const { channel } = await client.conversations.open({ users: myUserId });
  const dmChannelId = channel.id;
  const text = message.text || '';

  const repoList = getRepoList();

  await client.chat.postMessage({
    channel: dmChannelId,
    text: [
      '🐛 Got your bug report. Which codebase(s) should I focus on? _(optional)_',
      '',
      repoList,
      '',
      'Reply with a repo name, or `skip` to let me infer it automatically.',
    ].join('\n'),
  });

  pendingApprovals.set(dmChannelId, {
    status: 'awaiting_repo',
    originalMessage: text,
  });
}

/**
 * Phase 2 — triggered when the user replies to the "which repo?" DM.
 * Parses the repo hint and runs the full analysis pipeline.
 */
async function handleRepoSelection({ message, client, pendingApprovals }) {
  const dmChannelId = message.channel;
  const pending = pendingApprovals.get(dmChannelId);
  if (!pending || pending.status !== 'awaiting_repo') return;

  const replyText = (message.text || '').trim();
  const isSkip = /^skip$/i.test(replyText);

  // Try to extract a known repo name from the reply
  const repoHint = isSkip ? null : (extractRepoFromText(replyText) || replyText);

  await runAnalysis({
    originalMessage: pending.originalMessage,
    repoHint,
    dmChannelId,
    client,
    pendingApprovals,
  });
}

/**
 * Runs triage + code scan and sends the analysis DM.
 * Called after repo selection (or skip).
 */
async function runAnalysis({ originalMessage, repoHint, dmChannelId, client, pendingApprovals }) {
  await client.chat.postMessage({
    channel: dmChannelId,
    text: repoHint
      ? `🔍 Scanning \`${repoHint}\` — this may take a moment...`
      : '🔍 Inferring repo and scanning — this may take a moment...',
  });

  try {
    // Triage
    const { priority, reasoning } = await triageBug(originalMessage);
    console.log(`[triage] ${priority}: ${reasoning}`);

    // Repo
    let repo = repoHint;
    if (!repo) {
      const discovery = await discoverRepo(originalMessage);
      repo = discovery.repo;
    }

    if (!repo) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: '❌ Could not identify the affected repository. Please specify a repo name and try again.',
      });
      pendingApprovals.delete(dmChannelId);
      return;
    }

    // Code scan
    const scanResult = await scanCode(repo, originalMessage);

    if (!scanResult.bugExists) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: [
          `❌ Could not confirm this bug in \`${repo}\`.`,
          '',
          `Analysis: ${scanResult.rca}`,
          '',
          'No PR will be raised. Reply with a different repo name to try again, or ignore this message.',
        ].join('\n'),
      });
      pendingApprovals.delete(dmChannelId);
      return;
    }

    // Send analysis DM
    const affectedStr = scanResult.affectedFiles.map((f) => `\`${f}\``).join('\n📍 ');

    const dmText = [
      `✅ Bug confirmed | ${priority}`,
      `📁 Repo: \`${repo}\``,
      `📍 Affected: ${affectedStr}`,
      '',
      `*RCA:* ${scanResult.rca}`,
      '',
      `*Fix Plan:*\n${scanResult.fixPlan}`,
      '',
      `⚠️ Risk: ${scanResult.risk}`,
      '',
      'Does this analysis look correct?',
      `• Correct anything wrong  • Ask questions  • Add context I might have missed`,
      '',
      `Reply \`APPROVE\` to raise a PR or \`REJECT <reason>\` to cancel.`,
      `_(You have ${MAX_CLARIFICATION_TURNS} clarification turns before I lock in the analysis.)_`,
    ].join('\n');

    await client.chat.postMessage({ channel: dmChannelId, text: dmText });

    // Seed conversation history with the analysis summary
    const analysisText = [
      'I have analyzed the bug and here is what I found:',
      `Priority: ${priority}`,
      `Repo: ${repo}`,
      `Affected: ${scanResult.affectedFiles.join(', ')}`,
      `RCA: ${scanResult.rca}`,
      `Fix Plan: ${scanResult.fixPlan}`,
      `Risk: ${scanResult.risk}`,
    ].join('\n');

    pendingApprovals.set(dmChannelId, {
      status: 'verifying',
      priority,
      repo,
      rca: scanResult.rca,
      affectedFiles: scanResult.affectedFiles,
      fixPlan: scanResult.fixPlan,
      risk: scanResult.risk,
      fileContents: scanResult.fileContents,
      originalMessage,
      clarificationTurns: 0,
      conversationHistory: [{ role: 'assistant', content: analysisText }],
    });
  } catch (err) {
    console.error('[listener] error:', err);
    await client.chat.postMessage({
      channel: dmChannelId,
      text: `❌ Error analyzing bug: ${err.message}`,
    });
    pendingApprovals.delete(dmChannelId);
  }
}

module.exports = { handleBugReport, handleRepoSelection };
