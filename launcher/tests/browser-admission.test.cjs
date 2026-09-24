const test = require('node:test');
const assert = require('node:assert/strict');
const { BrowserAdmission } = require('../electron/browser-admission.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));

test('parked parents retain pages while children use generation capacity; resume waits for a permit', async () => {
  let pages = 0;
  const queue = new BrowserAdmission({ capacity: 2, activeCount: () => pages });
  const request = id => queue.request({ traceId: id, helperPid: 1, identity: id, start: async () => { pages++; return { surfaceId: id }; }, abandon: async () => { pages--; } });
  request('parent-a'); request('parent-b'); await tick();
  queue.park('parent-a', 1, 1); queue.park('parent-b', 1, 1);
  request('child-a'); request('child-b'); await tick();
  assert.equal(pages, 4);
  assert.equal(queue.resume('parent-a', 1, 1).queued, true);
  assert.throws(() => queue.park('parent-a', 2, 1), /another helper/);
  pages--; queue.release('child-a', 1);
  assert.equal(queue.resume('parent-a', 1, 1).queued, false);
  // A duplicate delayed park frame cannot revoke a granted resume permit.
  queue.park('parent-a', 1, 1);
  request('another-child'); await tick();
  assert.equal(pages, 3);
  assert.equal(queue.cancel('parent-b', 1), false, 'parked page still needs terminal cleanup');
});

test('page exhaustion returns a bounded local failure so parked ancestors can receive child results', async () => {
  let pages = 0;
  const queue = new BrowserAdmission({ capacity: 2, pageCapacity: 3, activeCount: () => pages });
  const request = id => queue.request({ traceId: id, helperPid: 1, identity: id, start: async () => { pages++; return {}; }, abandon: async () => { pages--; } });
  for (const id of ['root', 'child', 'grandchild']) { request(id); await tick(); queue.park(id, 1, 1); }
  assert.throws(() => request('next-child'), { code: 'browser_page_capacity_exhausted' });
  assert.equal(queue.resume('grandchild', 1, 1).queued, false);
  assert.equal(pages, 3);
});

test('host-reaped acquired entries are removed before admitting more work', async () => {
  const pages = new Set();
  const queue = new BrowserAdmission({ capacity: 1, maxQueued: 1, activeCount: () => pages.size, ownsActivePage: id => pages.has(id) });
  const request = id => queue.request({ traceId: id, helperPid: 1, identity: id, start: async () => { pages.add(id); return {}; }, abandon: async () => { pages.delete(id); } });
  request('first'); await tick(); queue.park('first', 1, 1);
  pages.delete('first');
  assert.doesNotThrow(() => request('second'));
  await tick();
  assert.equal(queue.entries.has('first'), false);
  assert.equal(queue.entries.size, 1);
});

test('admission is FIFO across helpers, idempotent, and separates queued cancellation from acquired work', async () => {
  let active = 0;
  const starts = [], observations = [];
  const queue = new BrowserAdmission({ capacity: 2, activeCount: () => active, report: (name, data) => observations.push([name, data]) });
  const request = index => queue.request({ traceId: `trace-${index}`, helperPid: index, identity: 'same', start: async () => { active++; starts.push(index); return { surfaceId: index }; }, abandon: async () => { active--; } });
  assert.equal(request(1).queued, true);
  request(2); request(3); request(4);
  await tick();
  assert.deepEqual(starts, [1, 2]);
  assert.deepEqual(request(1), { queued: false, surfaceId: 1 });
  assert.deepEqual(starts, [1, 2]);
  assert.equal(queue.cancel('trace-3', 3), true);
  active--; queue.release('trace-1', 1);
  await tick();
  assert.deepEqual(starts, [1, 2, 4]);
  assert.equal(active, 2);
  assert.ok(observations.some(([name]) => name === 'browser.queue_cancelled'));
  assert.throws(() => queue.cancel('trace-2', 99), /another helper/);
});

test('cancellation during acquisition releases the late surface without admitting excess work', async () => {
  let active = 0, finish;
  const queue = new BrowserAdmission({ capacity: 1, activeCount: () => active });
  queue.request({ traceId: 'first', helperPid: 1, identity: '', start: async () => { await new Promise(resolve => { finish = resolve; }); active++; return {}; }, abandon: async () => { active--; } });
  await tick();
  assert.equal(queue.cancel('first', 1), true);
  let second = false;
  queue.request({ traceId: 'second', helperPid: 2, identity: '', start: async () => { second = true; active++; return {}; }, abandon: async () => {} });
  assert.equal(second, false);
  finish(); await tick();
  assert.equal(second, true);
  assert.equal(active, 1);
});

test('unpolled or dead queued owners expire while active work is preserved', async () => {
  let now = 0;
  const queue = new BrowserAdmission({ capacity: 1, activeCount: () => 1, now: () => now, ownerAlive: pid => pid !== 3, maxQueued: 2 });
  const request = pid => queue.request({ traceId: String(pid), helperPid: pid, identity: '', start: async () => assert.fail('capacity occupied'), abandon: async () => {} });
  request(1); request(2);
  assert.throws(() => request(4), /queue is full/);
  now = 30_001; request(3); queue.sweep();
  assert.equal(queue.entries.size, 0);
});

test('queued and deferred admission events retain the originating diagnostic context through another task release', async () => {
  let active = 0;
  const seen = [];
  const queue = new BrowserAdmission({ capacity: 1, activeCount: () => active, report: (name, data, context) => seen.push({ name, task: data.traceId, context }) });
  const request = (id, traceId) => queue.request({ traceId: id, helperPid: 1, identity: id, diagnosticContext: { traceId, spanId: 'span', taskId: id }, start: async () => { active++; return {}; }, abandon: async () => { active--; } });
  request('first', 'first-context'); await tick();
  request('second', 'second-context');
  assert.throws(() => request('second', 'wrong-context'), { code: 'browser_admission_owner_mismatch' });
  assert.equal(queue.reportOwned('first', 1, 'browser.turn_started', { traceId: 'first' }), true);
  assert.equal(queue.reportOwned('first', 2, 'browser.turn_started', { traceId: 'first' }), false);
  active--; queue.release('first', 1); await tick();
  assert.equal(queue.reportOwned('second', 1, 'browser.turn_ended', { traceId: 'second', status: 'completed' }), true);
  active--; queue.release('second', 1);
  assert.ok(seen.some(event => event.task === 'second' && event.name === 'browser.acquisition_completed'));
  assert.equal(seen.filter(event => event.name === 'browser.admission_released').length, 2);
  assert.ok(seen.some(event => event.name === 'browser.turn_started' && event.context.traceId === 'first-context'));
  assert.ok(seen.some(event => event.name === 'browser.turn_ended' && event.context.traceId === 'second-context'));
  assert.ok(seen.every(event => event.context.traceId === `${event.task}-context` && event.context.taskId === event.task));
});
