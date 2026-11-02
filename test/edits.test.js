import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { EDIT_MODELS, edit, editBillingMode, editModel, PREMIUM_QUALITY } from '../cli/lib/paint.js';
import { figureModels } from '../cli/lib/figures.js';
import { lintPlan } from '../cli/lib/lint.js';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const plan = (extra = {}) => ({ id: 'w', title: 'W', canvas: '1344x768', order: 'free', voices: {}, places: [], ...extra });

// edit() races each job against a 15-minute timer that the CLI's exit clears; mocked here so the test ends.
mock.timers.enable({ apis: ['setTimeout'] });

/** A session whose client records what it was asked to create. */
function fakeSession({ mode = 'tokens', options = {} } = {}) {
  const created = [];
  return {
    created,
    billing: { mode, tokenType: 'spark' },
    client: {
      projects: {
        getModelOptions: async model => options[model] ?? null,
        create: async params => {
          created.push(params);
          return { id: `p${created.length}`, waitForCompletion: async () => [PNG] };
        },
      },
    },
  };
}

test('edits route by the world and the picture, and never to Qwen Image Edit', () => {
  assert.equal(editModel(plan()), 'flux3_image_klein_sd_int8_convrot', 'places, props and writing: FLUX 3 Image Klein');
  assert.equal(editModel(plan(), { people: true }), 'krea2_identity_edit_v1_2', 'a person in the close look: Krea 2 Identity Edit');
  assert.equal(editModel(plan({ mature: true })), 'dark_beast_krea2_identity_edit_v1_2', 'an 18+ world: Dark Beast');
  assert.equal(editModel(plan({ mature: true }), { people: true }), 'dark_beast_krea2_identity_edit_v1_2');
  assert.equal(editModel(plan({ intro: { warning: 'Rated 18+: graphic horror' } })), 'dark_beast_krea2_identity_edit_v1_2', 'a title card that warns 18+');
  assert.equal(editModel(plan({ edits: 'premium' }), { people: true }), 'gpt-image-2.5-sunburst', 'the person chose Premium Spark');
  assert.equal(editModel(plan({ edits: 'premium', mature: true })), 'dark_beast_krea2_identity_edit_v1_2', 'GPT Image refuses gore: an 18+ world stays on Dark Beast');
  assert.ok(!Object.values(EDIT_MODELS).some(model => /qwen/i.test(model)));
  assert.equal(figureModels(plan()).plate, EDIT_MODELS.things, 'a figure plate is a thing on white');
  assert.equal(figureModels(plan({ edits: 'premium' })).plate, EDIT_MODELS.premium);
});

test('an edit sends its model with that model\'s own tier defaults', async () => {
  const session = fakeSession({ mode: 'subscription', options: { [EDIT_MODELS.things]: { steps: { default: 16 }, guidance: { default: 1 }, sampler: { default: 'euler' }, scheduler: { default: 'simple' } } } });
  const { modelId, images } = await edit(session, { model: EDIT_MODELS.things, prompt: 'p', context: [Buffer.from('a')], width: 1344, height: 768, count: 3 });
  assert.equal(modelId, EDIT_MODELS.things);
  assert.equal(images.length, 1);
  const [sent] = session.created;
  assert.equal(sent.modelId, EDIT_MODELS.things);
  assert.deepEqual([sent.steps, sent.guidance, sent.sampler, sent.scheduler], [16, 1, 'euler', 'simple']);
  assert.equal(sent.numberOfMedia, 3);
  assert.equal(sent.billingMode, 'subscription', 'an Unlimited plan pays for Klein');
  assert.equal(sent.gptImageQuality, undefined);
});

test('a premium edit asks GPT Image 2.5 for its best quality and pays in tokens', async () => {
  const session = fakeSession({ mode: 'subscription' });
  await edit(session, { model: EDIT_MODELS.premium, prompt: 'p', context: [Buffer.from('a'), Buffer.from('b')], width: 1024, height: 1024 });
  const [sent] = session.created;
  assert.equal(sent.modelId, 'gpt-image-2.5-sunburst');
  assert.equal(sent.gptImageQuality, PREMIUM_QUALITY);
  assert.equal(sent.steps, undefined);
  assert.equal(sent.billingMode, 'tokens', 'no Unlimited plan covers GPT Image 2.5');
  assert.equal(editBillingMode(EDIT_MODELS.people, { mode: 'subscription' }), 'subscription');
});

test('an edit takes one or two context pictures', async () => {
  const session = fakeSession();
  await assert.rejects(edit(session, { model: EDIT_MODELS.people, prompt: 'p', context: [], width: 1024, height: 1024 }), /one or two/);
  await assert.rejects(edit(session, { model: EDIT_MODELS.people, prompt: 'p', context: [1, 2, 3].map(n => Buffer.from(String(n))), width: 1024, height: 1024 }), /one or two/);
  assert.equal(session.created.length, 0);
});

test('lint checks mature, edits and a close look\'s people', () => {
  const errors = (p, field) => lintPlan(p, { dir: '/nowhere' }, { checkFiles: false }).filter(f => f.where.startsWith(field)).map(f => `${f.level}: ${f.message}`);
  assert.deepEqual(errors(plan({ mature: true, edits: 'premium' }), 'mature'), []);
  assert.ok(errors(plan({ mature: 'yes' }), 'mature').some(m => /^error: mature is true/.test(m)));
  assert.ok(errors(plan({ edits: 'gpt' }), 'edits').some(m => /^error: edits is premium/.test(m)));
  assert.ok(errors(plan({ edits: 'premium', mature: true }), 'edits').some(m => /^warn: .*does nothing here/.test(m)));
  assert.deepEqual(errors(plan({ edits: 'premium' }), 'edits'), []);
  const film = { frames: 141, action: 'Live-action, cinematic, a wide shot begins in the position and framing established by Picture 1: a desk. A hand turns the glove over.', sound: 'Paper rustles.' };
  const withReveal = reveal => plan({ voices: {}, places: [{ id: 'office', still: 'stills/office.jpg', title: 'Office', seen: 'An office.', objects: [{ id: 'glove', label: 'Turn the glove over', at: [0.5, 0.5], film, reveal }] }] });
  const revealErrors = reveal => lintPlan(withReveal(reveal), { dir: '/nowhere' }, { checkFiles: false }).filter(f => f.level === 'error' && f.where.includes('reveal')).map(f => f.message);
  assert.deepEqual(revealErrors({ paint: 'She turns to you.', people: true, line: 'x' }), []);
  assert.ok(revealErrors({ paint: 'She turns to you.', people: 'yes', line: 'x' }).some(m => /people is true/.test(m)));
});
