const Anthropic = require('@anthropic-ai/sdk');
const { Octokit } = require('@octokit/rest');

const client = new Anthropic();

function makeBranchName(repo, rca) {
  const slug = rca
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 6)
    .join('-')
    .toLowerCase()
    .slice(0, 60);
  return `fix/${repo}-${slug}`;
}

/**
 * Step 1 — Ask Claude WHAT to change (file paths + short descriptions only).
 * NO prBody, NO long text — keeps JSON tiny and safe from truncation.
 */
async function planFix({ originalMessage, rca, fixPlan, fileContents }) {
  const fileList = Object.keys(fileContents).join('\n');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are planning a code fix. Identify which files need to change.

Bug: "${originalMessage}"
RCA: ${rca}
Fix Plan: ${fixPlan}

Files available:
${fileList}

Respond with ONLY this JSON (no markdown, no extra text). All string values must be short (one line each):
{"changes":[{"path":"<exact file path>","description":"<one sentence what to change>","commitMessage":"<fix(scope): short message>"}],"prTitle":"<fix(scope): title under 72 chars>"}`,
    }],
  });

  const response = await stream.finalMessage();
  const raw = response.content[0].text.trim();
  console.log('[github] planFix raw length:', raw.length, '| preview:', raw.slice(0, 120));

  // Strip markdown code fences if present
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (e2) {
        throw new Error(`planFix JSON parse failed: ${e2.message} | raw: ${text.slice(0, 300)}`);
      }
    }
    throw new Error(`planFix: no JSON found in response | raw: ${text.slice(0, 300)}`);
  }
}

/**
 * Step 2 — For a single file, ask Claude to apply the fix and return new content as plain text.
 * No JSON wrapping — avoids all truncation and escaping issues.
 */
async function generateFileContent({ filePath, currentContent, changeDescription, bugDescription, rca }) {
  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{
      role: 'user',
      content: `Apply the following fix to this source file. Return ONLY the complete new file content — no explanation, no markdown, no code fences. Just the raw file content ready to commit.

Bug: "${bugDescription}"
RCA: ${rca}
Fix to apply: ${changeDescription}

Current file content:
${currentContent}`,
    }],
  });

  const response = await stream.finalMessage();
  return response.content[0].text;
}

/**
 * Creates a branch, commits Claude-generated fixes, opens a PR, returns the PR URL.
 */
async function createFixAndPR({ priority, repo, rca, affectedFiles, fixPlan, fileContents, originalMessage }) {
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
  const owner = process.env.GITHUB_ORG;
  const baseBranch = 'develop';

  const { data: refData } = await octokit.git.getRef({
    owner, repo, ref: `heads/${baseBranch}`,
  });
  const baseSha = refData.object.sha;

  // Create fix branch
  const branchName = makeBranchName(repo, rca);
  await octokit.git.createRef({
    owner, repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // Plan: what files to change and how (small JSON, no content, no long strings)
  const fixData = await planFix({ originalMessage, rca, fixPlan, fileContents });

  if (!fixData.changes || fixData.changes.length === 0) {
    throw new Error('Claude returned no file changes in the fix plan');
  }

  // Apply each change: generate content as plain text, then commit
  for (const change of fixData.changes) {
    const currentContent = fileContents[change.path];
    if (!currentContent) {
      console.warn(`[github] skipping ${change.path} — not in fileContents`);
      continue;
    }

    // Generate new file content as plain text (no JSON parsing risk)
    const newContent = await generateFileContent({
      filePath: change.path,
      currentContent,
      changeDescription: change.description,
      bugDescription: originalMessage,
      rca,
    });

    // Get current file SHA from GitHub (required for updates)
    const { data: existing } = await octokit.repos.getContent({
      owner, repo, path: change.path, ref: branchName,
    });

    await octokit.repos.createOrUpdateFileContents({
      owner, repo,
      path: change.path,
      message: change.commitMessage || `fix: bugbot ${priority} fix`,
      content: Buffer.from(newContent).toString('base64'),
      sha: existing.sha,
      branch: branchName,
    });

    console.log(`[github] committed ${change.path}`);
  }

  // Build PR body using standard template
  const whatChanged = fixData.changes.map((c) => `- ${c.description}`).join('\n');
  const prBody = [
    '## What',
    '',
    whatChanged,
    '',
    '## Why',
    '',
    `**RCA:** ${rca}`,
    '',
    `**Priority:** ${priority}`,
    '',
    '## Impact',
    '',
    `Affected: ${affectedFiles.join(', ')}`,
    '',
    fixPlan.split('\n')[0],
    '',
    '🤖 Generated by BugBot',
  ].join('\n');

  // Open PR against develop
  const { data: pr } = await octokit.pulls.create({
    owner, repo,
    title: fixData.prTitle || `fix: BugBot ${priority} automated fix`,
    body: prBody,
    head: branchName,
    base: baseBranch,
  });

  return pr.html_url;
}

module.exports = { createFixAndPR };
