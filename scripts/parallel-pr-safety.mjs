import fs from 'node:fs';

const marker = '<!-- ting-parallel-pr-safety -->';
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const eventPath = process.env.GITHUB_EVENT_PATH;

if (!repo || !token || !eventPath) {
  throw new Error('Missing GitHub Actions environment');
}

const [owner, name] = repo.split('/');
const event = JSON.parse(fs.readFileSync(eventPath, 'utf8'));
const current = event.pull_request;
if (!current) process.exit(0);

const config = JSON.parse(fs.readFileSync('.github/parallel-pr-domains.json', 'utf8'));

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${token}`,
  'X-GitHub-Api-Version': '2022-11-28'
};

async function api(path, options = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  if (res.status === 204) return null;
  return res.json();
}

async function paged(path) {
  const out = [];
  for (let page = 1; ; page++) {
    const join = path.includes('?') ? '&' : '?';
    const rows = await api(`${path}${join}per_page=100&page=${page}`);
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}

function domainsFor(files) {
  const domains = new Set();
  for (const [domain, prefixes] of Object.entries(config.domains || {})) {
    if (files.some(file => prefixes.some(prefix => file === prefix || file.startsWith(prefix)))) {
      domains.add(domain);
    }
  }
  return domains;
}

const currentFiles = (await paged(`/repos/${owner}/${name}/pulls/${current.number}/files`)).map(x => x.filename);
const currentDomains = domainsFor(currentFiles);
const openPrs = await paged(`/repos/${owner}/${name}/pulls?state=open`);

const findings = [];
for (const pr of openPrs) {
  if (pr.number === current.number || pr.base.ref !== current.base.ref) continue;

  const files = (await paged(`/repos/${owner}/${name}/pulls/${pr.number}/files`)).map(x => x.filename);
  const direct = [...new Set(currentFiles.filter(file => files.includes(file)))].sort();
  const otherDomains = domainsFor(files);
  const sharedDomains = [...currentDomains].filter(domain => otherDomains.has(domain)).sort();

  if (!direct.length && !sharedDomains.length) continue;

  findings.push({
    number: pr.number,
    title: pr.title,
    url: pr.html_url,
    direct,
    sharedDomains
  });
}

let body = `${marker}\n## Parallel PR safety\n\n`;
if (!findings.length) {
  body += 'No direct file overlap or shared TinG risk-domain overlap detected with other open PRs targeting this base branch.\n';
} else {
  body += 'This is an advisory coordination check. It does **not** merge, rebase, or modify another branch.\n\n';
  for (const finding of findings) {
    const level = finding.direct.length ? '**DIRECT OVERLAP**' : '**SHARED RISK SURFACE**';
    body += `- ${level} with [#${finding.number}](${finding.url}) — ${finding.title}\n`;
    if (finding.direct.length) {
      body += `  - Same files: ${finding.direct.map(x => `\`${x}\``).join(', ')}\n`;
      body += '  - Required action: reconcile before merge; do not assume parallel changes are independent.\n';
    }
    if (finding.sharedDomains.length) {
      body += `  - Shared domains: ${finding.sharedDomains.map(x => `\`${x}\``).join(', ')}\n`;
      body += '  - Required action: after either PR merges, refresh/revalidate the other PR against the new `main` before merge.\n';
    }
  }
}

const comments = await paged(`/repos/${owner}/${name}/issues/${current.number}/comments`);
const previous = comments.find(comment => comment.body?.includes(marker) && comment.user?.type === 'Bot');

if (previous) {
  await api(`/repos/${owner}/${name}/issues/comments/${previous.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ body })
  });
} else {
  await api(`/repos/${owner}/${name}/issues/${current.number}/comments`, {
    method: 'POST',
    body: JSON.stringify({ body })
  });
}
