const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');

const root = path.join(__dirname, '..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/validate.yml'), 'utf8');
// Exercise the actual privileged workflow script, including the eligibility
// checks, rather than maintaining a second copy of its validation logic.
const block = workflow.split('  publish:\n')[1].split('          script: |\n')[1];
const script = block.split('\n').filter(line => line.trim()).map(line => {
  assert.ok(line.startsWith('            '), 'unexpected publish script boundary');
  return line.slice(12);
}).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const publish = new AsyncFunction('github', 'context', 'core', 'process', script);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'flake.lock'), 'utf8'));

function scenario() {
  return {
    before: structuredClone(lock), after: structuredClone(lock),
    pr: {
      state: 'open', draft: false, user: {login: 'github-actions[bot]'},
      head: {sha: 'tested-head', ref: 'automation/weekly-123-1', repo: {full_name: 'Noot-tooN/RaspPiHomeserver'}},
      base: {ref: 'master'},
    },
    master: {commit: {sha: 'tested-base'}},
    files: [{filename: 'flake.lock', status: 'modified'}],
    env: {
      BUILT_SHA: 'tested-head', BASE_SHA: 'tested-base', PR_NUMBER: '11',
      BUILD_RESULT: 'success', AUTO_MERGE: 'true', GITHUB_REPOSITORY: 'Noot-tooN/RaspPiHomeserver',
    },
    merges: [], statuses: [],
  };
}

async function run(s) {
  const github = {
    rest: {
      pulls: {
        get: async () => ({data: s.pr}), listFiles: () => {},
        merge: async request => { s.merges.push(request); return {data: {merged: true}}; },
      },
      repos: {
        getBranch: async () => ({data: s.master}),
        createCommitStatus: async request => { s.statuses.push(request); },
        getContent: async ({ref}) => {
          assert.ok(['tested-base', 'tested-head'].includes(ref));
          const value = ref === 'tested-base' ? s.before : s.after;
          return {data: {content: Buffer.from(JSON.stringify(value)).toString('base64')}};
        },
      },
    },
    paginate: async () => s.files,
  };
  await publish(github, {repo: {owner: 'Noot-tooN', repo: 'RaspPiHomeserver'}, serverUrl: 'https://github.com', runId: 123}, {notice() {}}, {env: s.env});
}

function rootNode(s, name) {
  return s.after.nodes[s.after.nodes[s.after.root].inputs[name]];
}

test('unpinned direct and transitive input revisions can update together', async () => {
  const s = scenario();
  for (const node of Object.values(s.after.nodes)) {
    if (!node.locked) continue;
    Object.assign(node.locked, {narHash: 'new-hash', lastModified: 123});
    // A real flake update preserves revisions explicitly pinned in flake.nix.
    if (!node.original?.rev) node.locked.rev = 'new-revision';
  }
  await run(s);
  assert.equal(s.merges.length, 1);
  assert.equal(s.merges[0].sha, 'tested-head');
  assert.equal(s.merges[0].merge_method, 'squash');
});

test('Nix node renaming does not change dependency identities', async () => {
  const s = scenario();
  s.after.nodes = Object.fromEntries(Object.entries(s.after.nodes).map(([name, node]) => {
    if (node.inputs) node.inputs = Object.fromEntries(Object.entries(node.inputs).map(([key, ref]) => [key, typeof ref === 'string' ? `renamed-${ref}` : ref]));
    return [`renamed-${name}`, node];
  }));
  s.after.root = `renamed-${s.after.root}`;
  await run(s);
  assert.equal(s.merges.length, 1);
});

test('explicit commit pins cannot advance through locked metadata alone', async () => {
  const s = scenario();
  const name = s.before.nodes[s.before.root].inputs['nixos-raspberrypi'];
  s.before.nodes[name].original.rev = s.before.nodes[name].locked.rev;
  s.after = structuredClone(s.before);
  s.after.nodes[name].locked.rev = 'different-revision';
  await assert.rejects(run(s), /Lock change/);
  assert.equal(s.merges.length, 0);
});

for (const [name, mutate] of [
  ['locked source owner', s => { rootNode(s, 'nixos-raspberrypi').locked.owner = 'another-owner'; }],
  ['original source', s => { rootNode(s, 'nixos-raspberrypi').original.repo = 'another-repo'; }],
  ['release branch', s => { rootNode(s, 'nixos-raspberrypi').original.ref = 'nixos-unstable'; }],
  ['transitive source', s => { s.after.nodes['flake-compat'].locked.repo = 'another-repo'; }],
  ['follows wiring', s => { rootNode(s, 'comin').inputs.nixpkgs = ['nixpkgs-unstable']; }],
  ['new root input', s => { s.after.nodes[s.after.root].inputs.extra = 'flake-compat'; }],
  ['new transitive input', s => { rootNode(s, 'comin').inputs.extra = 'flake-compat'; }],
  ['removed input', s => { delete s.after.nodes[s.after.root].inputs.comin; }],
  ['flake mode', s => { s.after.nodes['flake-compat'].flake = true; }],
  ['lock format', s => { s.after.version++; }],
]) {
  test(`rejects changes to ${name}`, async () => {
    const s = scenario(); mutate(s);
    await assert.rejects(run(s), /Lock change/);
    assert.equal(s.merges.length, 0);
  });
}

for (const [name, mutate] of [
  ['unrelated file', s => { s.files.push({filename: 'flake.nix', status: 'modified'}); }],
  ['lock deletion', s => { s.files[0].status = 'removed'; }],
  ['non-bot author', s => { s.pr.user.login = 'someone-else'; }],
  ['external fork', s => { s.pr.head.repo.full_name = 'someone-else/RaspPiHomeserver'; }],
  ['non-weekly branch', s => { s.pr.head.ref = 'feature'; }],
  ['wrong target branch', s => { s.pr.base.ref = 'another-branch'; }],
  ['draft PR', s => { s.pr.draft = true; }],
  ['closed PR', s => { s.pr.state = 'closed'; }],
  ['new PR head', s => { s.pr.head.sha = 'untested-head'; }],
  ['new master head', s => { s.master.commit.sha = 'untested-base'; }],
  ['failed build', s => { s.env.BUILD_RESULT = 'failure'; }],
  ['disabled auto-merge', s => { s.env.AUTO_MERGE = 'false'; }],
]) {
  test(`withholds merge for ${name}`, async () => {
    const s = scenario(); mutate(s);
    await run(s);
    assert.equal(s.merges.length, 0);
  });
}
