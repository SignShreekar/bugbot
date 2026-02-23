const { triageBug } = require('./triage');
const { discoverRepo, getAvailableRepos, extractRepoFromText } = require('./repoDiscovery');
const { scanCode } = require('./codeScan');

const MAX_CLARIFICATION_TURNS = 3;

// Tracks completed analyses keyed by normalized bug text
const analyzedBugs = new Map();

function normalizeBugText(text) {
  return text
    .replace(/<@[A-Z0-9]+>/g, '')
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

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

  // Duplicate detection — resume if this bug was already analyzed
  const normalizedText = normalizeBugText(text);
  const previousAnalysis = analyzedBugs.get(normalizedText);
  if (previousAnalysis) {
    console.log(`[listener] duplicate bug detected, resuming previous analysis`);
    pendingApprovals.set(dmChannelId, { ...previousAnalysis, status: 'verifying' });
    await client.chat.postMessage({
      channel: dmChannelId,
      text: [
        '⚠️ This bug was already reported and analyzed.',
        '',
        `*Previous analysis:* ${previousAnalysis.rca}`,
        `*Repo:* \`${previousAnalysis.repo}\` | *Priority:* ${previousAnalysis.priority}`,
        '',
        'Resuming from where we left off. Reply `APPROVE` to raise a PR, `REJECT <reason>` to cancel, or ask follow-up questions.',
      ].join('\n'),
    });
    return;
  }

  const repos = getAvailableRepos();
  const numberedList = repos.map((r, i) => `${i + 1}. \`${r.name}\` — ${r.desc}`).join('\n');

  await client.chat.postMessage({
    channel: dmChannelId,
    text: [
      '🐛 Got your bug report. Which codebase should I focus on?',
      '',
      numberedList,
      `${repos.length + 1}. Let me infer automatically`,
      '',
      'Reply with a number.',
    ].join('\n'),
  });

  pendingApprovals.set(dmChannelId, {
    status: 'awaiting_repo',
    originalMessage: text,
    repoOptions: repos,
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
  const repos = pending.repoOptions || [];
  const autoInferIndex = repos.length + 1;

  let repoHint = null;
  const num = parseInt(replyText, 10);
  if (!isNaN(num) && num === autoInferIndex) {
    repoHint = null; // auto-infer
  } else if (!isNaN(num) && num >= 1 && num <= repos.length) {
    repoHint = repos[num - 1].name;
  } else {
    // Fallback: try to extract repo name from free text
    repoHint = extractRepoFromText(replyText) || (replyText.toLowerCase() === 'skip' ? null : replyText);
  }

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
      ? `🔍 Starting analysis on \`${repoHint}\`...`
      : '🔍 Starting analysis — will infer repo automatically...',
  });

  try {
    // Step 1: Triage
    await client.chat.postMessage({ channel: dmChannelId, text: '⚙️ Step 1/3: Triaging bug priority...' });
    const { priority, reasoning } = await triageBug(originalMessage);
    console.log(`[triage] ${priority}: ${reasoning}`);
    await client.chat.postMessage({ channel: dmChannelId, text: `✅ Priority: *${priority}* — ${reasoning}` });

    // Step 2: Repo discovery
    let repo = repoHint;
    if (!repo) {
      await client.chat.postMessage({ channel: dmChannelId, text: '⚙️ Step 2/3: Inferring affected repository...' });
      const discovery = await discoverRepo(originalMessage);
      repo = discovery.repo;
      if (repo) {
        await client.chat.postMessage({ channel: dmChannelId, text: `✅ Identified repo: \`${repo}\` (${discovery.confidence} confidence)` });
      }
    } else {
      await client.chat.postMessage({ channel: dmChannelId, text: `⚙️ Step 2/3: Using repo \`${repo}\`...` });
    }

    if (!repo) {
      await client.chat.postMessage({
        channel: dmChannelId,
        text: '❌ Could not identify the affected repository. Please specify a repo name and try again.',
      });
      pendingApprovals.delete(dmChannelId);
      return;
    }

    // Step 3: Code scan
    await client.chat.postMessage({ channel: dmChannelId, text: `⚙️ Step 3/3: Scanning \`${repo}\` and building RCA...` });
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

    const analysisState = {
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
    };

    // Store analysis for duplicate detection
    analyzedBugs.set(normalizeBugText(originalMessage), analysisState);

    pendingApprovals.set(dmChannelId, analysisState);
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
