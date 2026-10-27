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
const msgArg = process.argv.find((a) => a.startsWith('--message='));
const CUSTOM_MSG = msgArg ? msgArg.slice('--message='.length) : '';

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
  const headMsg = CUSTOM_MSG || gitText(['log', '-1', '--pretty=%B']).replace(/\s+$/, '');

  const ref = await api('GET', `/repos/${owner}/${repo}/git/ref/heads/main`);
  const remoteSha = ref.object.sha;

  if (remoteSha === headSha) {
    console.log('远端已是最新，无需推送');
    return;
  }

  // 以「远端 main」为父提交；远端提交对象本地不一定存在，
  // 所以文件差异靠「两边 tree 对比」算，而不是 git diff。
  const parentSha = remoteSha;
  const parentCommit = await api('GET', `/repos/${owner}/${repo}/git/commits/${parentSha}`);
  const baseTree = parentCommit.tree.sha;

  const remoteTree = await api('GET', `/repos/${owner}/${repo}/git/trees/${baseTree}?recursive=1`);
  const remoteBlobs = new Map();
  for (const item of remoteTree.tree || []) {
    if (item.type === 'blob') remoteBlobs.set(item.path, item.sha);
  }

  const localBlobs = new Map();
  for (const line of gitText(['ls-tree', '-r', headSha]).split('\n')) {
    if (!line.trim()) continue;
    // 形如：100644 blob 0123abc...\tpath/to/file
    const m2 = /^\d+\s+blob\s+([0-9a-f]+)\t(.+)$/.exec(line);
    if (m2) localBlobs.set(m2[2], m2[1]);
  }

  const upserts = [];
  for (const [file, sha] of localBlobs) {
    if (remoteBlobs.get(file) !== sha) upserts.push(file);
  }
  const deletes = [...remoteBlobs.keys()].filter((p) => !localBlobs.has(p));

  console.log(`仓库：${owner}/${repo}`);
  console.log(`父提交：${parentSha.slice(0, 7)}  本地：${headSha.slice(0, 7)}`);
  console.log(`需要更新 ${upserts.length} 个文件，删除 ${deletes.length} 个`);

  // 4. 逐个创建 blob
  const treeEntries = [];
  for (const file of deletes) {
    treeEntries.push({ path: file, mode: '100644', type: 'blob', sha: null });
    console.log(`  删除 ${file}`);
  }

  for (const file of upserts) {
    const buf = git(['show', `${headSha}:${file}`]);
    if (DRY) {
      console.log(`  [dry] 更新 ${file}（${buf.length} 字节）`);
      continue;
    }
    const blob = await api('POST', `/repos/${owner}/${repo}/git/blobs`, {
      content: buf.toString('base64'),
      encoding: 'base64',
    });
    treeEntries.push({
      path: file,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
    console.log(`  ${remoteBlobs.has(file) ? '更新' : '新增'} ${file}（${buf.length} 字节）`);
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

  // 6. 本地引用同步：API 创建的提交对象本地没有，能拿到就更新，拿不到就提示
  try {
    execFileSync('git', ['cat-file', '-e', `${commit.sha}^{commit}`], {
      cwd: ROOT,
      stdio: 'ignore',
    });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', commit.sha], { cwd: ROOT });
    console.log('本地 origin/main 已同步');
  } catch {
    console.log(
      '提示：本地没有该提交对象（API 生成），因此 origin/main 未能更新。\n' +
        '      内容与远端完全一致；等 git 协议恢复后执行一次：\n' +
        '        git fetch origin && git reset --hard origin/main'
    );
  }

  console.log(`\n已通过 API 推送：${commit.sha.slice(0, 7)}  ${commit.html_url || ''}`);
}

main().catch((err) => {
  console.error('推送失败：', err.message || err);
  process.exit(1);
});
