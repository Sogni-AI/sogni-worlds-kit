import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the sogni-worlds skill carries what ClawHub lists it by, at the kit\'s version', () => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(read('skills/sogni-worlds/SKILL.md'));
  assert.ok(front, 'SKILL.md starts with YAML frontmatter');
  const meta = parse(front[1]);
  assert.equal(meta.name, 'sogni-worlds', 'the name is the ClawHub slug');
  assert.ok(meta.description.length > 100 && meta.description.length < 1024, 'a description agents trigger on');
  assert.equal(meta.metadata.version, JSON.parse(read('package.json')).version, 'npm run publish:clawhub publishes the kit\'s version');
  assert.equal(meta.metadata.homepage, 'https://github.com/Sogni-AI/sogni-worlds-kit');
  assert.deepEqual(meta.metadata.openclaw.requires.bins, ['node', 'git']);
});

test('installed without the kit, the skill says how to fetch and set it up', () => {
  const body = read('skills/sogni-worlds/SKILL.md');
  for (const step of ['git clone https://github.com/Sogni-AI/sogni-worlds-kit', 'npm install', 'node world doctor', 'node world setup']) {
    assert.ok(body.includes(step), step);
  }
});
