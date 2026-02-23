const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const client = new Anthropic();

const BASE_PATH = '/Users/shreekarhegde';
const SOURCE_EXTENSIONS = /\.(js|ts|jsx|tsx|py|go|java|rb|rs|cpp|c|cs|php|swift|kt|vue|mjs|cjs)$/;
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.cache', 'vendor', 'tmp', 'logs',
]);
const MAX_FILE_SIZE_BYTES = 120_000;
const MAX_FILES_TO_WALK = 400;
const MAX_FILES_TO_READ = 6;

function walkDir(dirPath) {
  const files = [];
  function walk(dir) {
    if (files.length >= MAX_FILES_TO_WALK) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (SOURCE_EXTENSIONS.test(entry.name)) files.push(full);
    }
  }
  walk(dirPath);
  return files;
}

function readFileSafe(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_FILE_SIZE_BYTES) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch { return null; }
}

/**
 * Greps the repo and returns matched snippets with surrounding context lines.
 * Returns { term: "grep output with context" }
 */
function grepWithContext(repoPath, terms) {
  const results = {};
  for (const term of terms.slice(0, 8)) {
    if (!term || term.length < 3) continue;
    try {
      const escaped = term.replace(/["\\]/g, '\\$&');
      const output = execSync(
        `grep -rn "${escaped}" "${repoPath}" \
          --include="*.ts" --include="*.js" --include="*.py" --include="*.go" \
          -B 4 -A 8 2>/dev/null | head -n 300`,
        { timeout: 8000 },
      ).toString().trim();
      if (output) results[term] = output;
    } catch { /* no matches */ }
  }
  return results;
}

/**
 * Gets unique file paths from grep results.
 */
function filePathsFromGrep(repoPath, terms) {
  const matched = new Set();
  for (const term of terms.slice(0, 8)) {
    if (!term || term.length < 3) continue;
    try {
      const escaped = term.replace(/["\\]/g, '\\$&');
      const output = execSync(
        `grep -ril "${escaped}" "${repoPath}" \
          --include="*.ts" --include="*.js" --include="*.py" --include="*.go" 2>/dev/null`,
        { timeout: 8000 },
      ).toString().trim();
      output.split('\n').filter(Boolean).forEach((f) => matched.add(f));
    } catch { /* no matches */ }
  }
  return [...matched];
}

async function scanCode(repoName, bugDescription) {
  const repoPath = path.join(BASE_PATH, repoName);

  if (!fs.existsSync(repoPath)) {
    return {
      bugExists: false,
      rca: `Repository \`${repoName}\` not found locally at ${repoPath}.`,
      affectedFiles: [], fixPlan: '', risk: 'Unknown', fileContents: {},
    };
  }

  // Step 1 — extract search terms from the bug description
  const termStream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [{
      role: 'user',
      content: `Extract specific technical search terms to grep for in source code to find the root cause of this bug.

Bug description:
"${bugDescription}"

Focus on: function names, route paths, error codes, feature-specific keywords, class names, API endpoint strings.

Respond with JSON only:
{ "searchTerms": ["term1", "term2", "term3"] }`,
    }],
  });

  const termResponse = await termStream.finalMessage();
  const termRaw = termResponse.content[0].text.trim();
  console.log('[codeScan] term extraction raw:', termRaw.slice(0, 300));

  let searchTerms = [];
  try {
    const termText = termRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(termText);
    searchTerms = parsed.searchTerms || [];
  } catch {
    const match = termRaw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        searchTerms = JSON.parse(match[0]).searchTerms || [];
      } catch { /* keep empty */ }
    }
  }
  console.log(`[codeScan] search terms:`, searchTerms);

  // Step 2 — grep with code context
  const grepSnippets = grepWithContext(repoPath, searchTerms);
  const greppedFiles = filePathsFromGrep(repoPath, searchTerms);

  const snippetStr = Object.entries(grepSnippets)
    .map(([term, output]) => `--- matches for "${term}" ---\n${output}`)
    .join('\n\n');

  // Step 3 — walk dir and let Claude pick files to read in full
  const allFiles = walkDir(repoPath);
  const relativeFiles = allFiles.map((f) => path.relative(repoPath, f));

  const selectionStream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 1024,
    messages: [{
      role: 'user',
      content: `You are debugging a bug in the "${repoName}" service.

Bug description:
"${bugDescription}"

Grep results with code context:
${snippetStr || '(no grep matches found)'}

All source files in repo:
${relativeFiles.join('\n')}

Based on the grep results and file list, select the most relevant files to read in full for a thorough RCA (max ${MAX_FILES_TO_READ}).

Respond with JSON only:
{
  "files": ["src/path/to/file.ts"],
  "reasoning": "brief explanation"
}`,
    }],
  });

  const selectionResponse = await selectionStream.finalMessage();
  const selRaw = selectionResponse.content[0].text.trim();
  console.log('[codeScan] file selection raw:', selRaw.slice(0, 300));

  let selectedRelative = [];
  try {
    const selText = selRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    const parsed = JSON.parse(selText);
    selectedRelative = parsed.files || [];
  } catch {
    const match = selRaw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        selectedRelative = JSON.parse(match[0]).files || [];
      } catch { /* keep empty */ }
    }
  }

  // Merge Claude picks + grep file hits
  const greppedRelative = greppedFiles.map((f) => path.relative(repoPath, f));
  const combined = [...new Set([...selectedRelative, ...greppedRelative])].slice(0, MAX_FILES_TO_READ);

  // Step 4 — read full file contents
  const fileContents = {};
  for (const relPath of combined) {
    const absPath = path.join(repoPath, relPath);
    const content = readFileSafe(absPath);
    if (content !== null) fileContents[relPath] = content;
  }

  if (Object.keys(fileContents).length === 0 && !snippetStr) {
    return {
      bugExists: false,
      rca: 'Could not find relevant code for this bug description.',
      affectedFiles: [], fixPlan: '', risk: 'Unknown', fileContents: {},
    };
  }

  // Step 5 — RCA with grep context + full file contents
  const fileContentStr = Object.entries(fileContents)
    .map(([p, c]) => `=== ${p} ===\n${c}`)
    .join('\n\n');

  const rcaStream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    messages: [{
      role: 'user',
      content: `You are a senior engineer doing root cause analysis for a bug in the "${repoName}" service.

Bug description:
"${bugDescription}"

Grep results (code snippets with context):
${snippetStr || '(none)'}

Full file contents:
${fileContentStr || '(none)'}

Perform a thorough RCA. Pinpoint the exact function, line, and code path causing the bug.

Respond with JSON only (no markdown):
{
  "bugExists": true,
  "rca": "2-3 sentence root cause referencing specific file/function/line",
  "affectedFiles": ["src/path/file.ts:L142"],
  "fixPlan": "1. Specific change at file:line\\n2. Second change\\n3. Add test case",
  "risk": "Low"
}

If you cannot confirm the bug exists in this code, set bugExists to false.`,
    }],
  });

  const rcaResponse = await rcaStream.finalMessage();
  const rcaText = rcaResponse.content[0].text.trim();

  try {
    return { ...JSON.parse(rcaText), fileContents };
  } catch {
    const match = rcaText.match(/\{[\s\S]*\}/);
    if (match) return { ...JSON.parse(match[0]), fileContents };
    throw new Error(`Could not parse RCA: ${rcaText}`);
  }
}

module.exports = { scanCode };
