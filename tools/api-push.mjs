/**
 * api-push.mjs —— 当 git 协议被网络阻断时，用 GitHub REST API 推送本地提交
 *
 * 背景：
 *   某些代理/网络环境下 `git push` 无法与 github.com:443 完成 TLS 握手，
 *   但 api.github.com 仍然可用（gh cli 能正常工作）。此时可以用 Git Data API
 *   手工构造一次提交：
 *
 *     blob（每个改动文件） → tree（基于父提交的 tree） → commit → 更新 ref
 *
 * 用法：
 *   node tools/api-push.mjs            # 推送 HEAD 到 origin/main
 *   node tools/api-push.mjs --dry-run  # 只打印将要做什么
 *
 * 前提：本地已 commit，且 `gh auth token` 可用。
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DRY = process.argv.includes('--dry-run');

const API = 'https://api.github.com';

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function gitText(args) {
  return git(args, { encoding: 'utf8' }).trim();
}

/* ------------------------------------------------------------------ *
 * GitHub API
 * ------------------------------------------------------------------ */
let token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
if (!token) {
  try {
    token = gitText(['--version']) && execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    token = '';
  }
}
if (!token) {
  console.error('拿不到 token：请先 gh auth login，或设置 GH_TOKEN 环境变量');
  process.exit(2);
}

async function api(method, endpoint, body) {
  const res = await fetch(API + endpoint, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'kunle-api-push',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    throw new Error(`${method} ${endpoint} → ${res.status} ${text.slice(0, 300)}`);
  }
  return json;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */
async function main() {
  // 1. 仓库信息
  const remote = gitText(['remote', 'get-url', 'origin']);
  const m = /github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/.exec(remote);
  if (!m) throw new Error('无法从 origin 解析 owner/repo：' + remote);
  const [, owner, repo] = m;

  // 2. 本地 HEAD 与父提交（远端 main）
  const headSha = gitText(['rev-parse', 'HEAD']);
  const headMsg = gitText(['log', '-1', '--pretty=%B']).replace(/\s+$/, '');

  const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/main`);
  const remoteSha = ref.object.sha;

  if (remoteSha === headSha) {
    console.log('远端已是最新，无需推送');
    return;
  }

  // 本地可能有多个未推送的提交：统一以「远端 main」为父提交，一次性推上去
  const parentSha = remoteSha;
  const parentCommit = await api('GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const baseTree = parentCommit.tree.sha;

  const localOnly = gitText(['rev-list', '--count', `${parentSha}..${headSha}`]);
  if (Number(localOnly) > 1) {
    console.log(`本地领先远端 ${localOnly} 个提交，将合并为一次 API 提交（内容完全一致）`);
  }

  // 3. 相对远端 main 改了哪些文件
  const status = gitText(['diff', '--name-status', parentSha, headSha])
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t');
      return { status: parts[0][0], file: parts[parts.length - 1] };
    });

  console.log(`仓库：${owner}/${repo}`);
  console.log(`父提交：${parentSha.slice(0, 7)}  本地：${headSha.slice(0, 7)}`);
  console.log(`改动文件：${status.length} 个`);

  // 4. 逐个创建 blob
  const treeEntries = [];
  for (const item of status) {
    if (item.status === 'D') {
      treeEntries.push({ path: item.file.replace(/\\/g, '/'), mode: '100644', type: 'blob', sha: null });
      console.log(`  删除 ${item.file}`);
      continue;
    }
    const buf = git(['show', `${headSha}:${item.file}`]);
    if (DRY) {
      console.log(`  [dry] 更新 ${item.file}（${buf.length} 字节）`);
      continue;
    }
    const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    treeEntries.push({
      path: item.file.replace(/\\/g, '/'),
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
    console.log(`  ${item.status === 'A' ? '新增' : '更新'} ${item.file}（${buf.length} 字节）`);
  }

  if (DRY) {
    console.log('\n[dry-run] 未做任何写操作');
    return;
  }

  // 5. 建 tree / commit / 更新 ref
  const tree = await api('POST', `/repos/${owner}/${repo}/git/trees`, {
    base_tree: baseTree,
    tree: treeEntries,
  });

  const name = gitText(['config', 'user.name']) || owner;
  const email = gitText(['config', 'user.email']) || `${owner}@users.noreply.github.com`;
  const date = new Date().toISOString();

  const commit = await api('POST', `/repos/${owner}/${repo}/git/commits`, {
    message: headMsg,
    tree: tree.sha,
    parents: [parentSha],
    author: { name, email, date },
    committer: { name, email, date },
  });

  await api('PATCH', `/repos/${owner}/${repo}/git/refs/heads/main`, {
    sha: commit.sha,
    force: false,
  });

  // 6. 让本地也认为已同步
  try {
    git(['update-ref', 'refs/remotes/origin/main', commit.sha]);
  } catch {
    /* 忽略 */
  }

  console.log(`\n已通过 API 推送：${commit.sha.slice(0, 7)}  ${commit.html_url || ''}`);
}

main().catch((err) => {
  console.error('推送失败：', err.message || err);
  process.exit(1);
});
