const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const client = new Anthropic();

const BASE_PATH = '/Users/shreekarhegde';

// Known microservice repos and their purpose
const KNOWN_REPOS = {
  'v4': 'Legacy API for backward compatibility',
  'documents': 'Document storage and retrieval for envelope sources',
  'file-system': 'PDF file operations and S3 interactions',
  'document-operation': 'PDF manipulation, annotations, merging and splitting',
  'accounts': 'User and organization data',
  'api-preference': 'User preferences and settings',
  'SE-OAuth2': 'API client (Auth0 app) interactions',
  'rbac': 'Role-based access control',
  'juno': 'Batch processing framework for Airflow dags/jobs',
  'webapp-v2': 'UI code — isICM flow (latest UI) and other renderings (legacy UI)',
  'Transactions': 'Go microservice managing document signing transactions, envelopes, and signing lifecycle (creation, approval, signing, completion, archival)',
  'template': 'Templates service for creating and saving roles and fields on the fly',
  'email-dispatcher': 'Email templates with action buttons sent to users',
};

/**
 * Returns repos that exist locally at BASE_PATH.
 */
function getAvailableRepos() {
  return Object.entries(KNOWN_REPOS)
    .filter(([name]) => fs.existsSync(path.join(BASE_PATH, name)))
    .map(([name, desc]) => ({ name, desc }));
}

/**
 * Formatted list string for display in Slack.
 */
function getRepoList() {
  const available = getAvailableRepos();
  if (available.length === 0) return Object.entries(KNOWN_REPOS).map(([n, d]) => `• ${n} — ${d}`).join('\n');
  return available.map((r) => `• ${r.name} — ${r.desc}`).join('\n');
}

/**
 * Tries to extract a known repo name from free-form user text.
 * Returns the first match, or null.
 */
function extractRepoFromText(text) {
  const lower = text.toLowerCase();
  for (const name of Object.keys(KNOWN_REPOS)) {
    if (lower.includes(name.toLowerCase())) return name;
  }
  return null;
}

/**
 * Uses Claude to infer the best repo from a bug description.
 * Prefers locally available repos.
 */
async function discoverRepo(bugDescription) {
  const available = getAvailableRepos();
  const list = available.length > 0 ? available : Object.entries(KNOWN_REPOS).map(([name, desc]) => ({ name, desc }));
  const repoList = list.map((r) => `- ${r.name}: ${r.desc}`).join('\n');

  const stream = client.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 256,
    messages: [
      {
        role: 'user',
        content: `Given this bug description, which single repository is most likely affected?

Bug:
"${bugDescription}"

Available repositories:
${repoList}

Respond with JSON only (no markdown):
{
  "repo": "exact-repo-name-or-null",
  "confidence": "high",
  "reasoning": "one sentence"
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
    throw new Error(`Could not parse repo discovery: ${text}`);
  }
}

module.exports = { discoverRepo, getRepoList, getAvailableRepos, extractRepoFromText };
