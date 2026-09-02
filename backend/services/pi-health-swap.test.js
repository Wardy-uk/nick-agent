// zram is compressed RAM, not a disk. The panel had been warning "Swapping
// hurts on an SD card / HDD" over a Pi 5 whose only swap device is /dev/zram0,
// where a 100% pool costs no disk writes at all — 1.98GB swapped out was
// occupying 16MB of RAM. A warning that is always on is one nobody reads.
const test = require('node:test');
const assert = require('node:assert');
const { assess } = require('./pi-health');

const GB = 2 ** 30;
const base = { total: 16 * GB, usedPct: 40 };
const swapIssues = (memory) =>
  assess({ memory }).issues.filter((i) => /swap|zram/i.test(i.title));

test('a full zram pool costing little RAM raises nothing', () => {
  // The live Pi 5 reading on 2 Sep 2026: 99% of the pool in use, holding
  // 1.98GB of (largely zeroed) pages compressed into 16MB.
  assert.deepEqual(swapIssues({
    ...base, swapPct: 99, swapUsed: 2076164096,
    swapBacking: 'zram', swapDevices: ['/dev/zram0'], zramRamBytes: 16613376
  }), []);
});

test('zram DOES warn once the pool itself is eating the machine', () => {
  const [issue] = swapIssues({
    ...base, swapPct: 99, swapUsed: 8 * GB,
    swapBacking: 'zram', swapDevices: ['/dev/zram0'], zramRamBytes: 4 * GB
  });
  assert.equal(issue.level, 'warn');
  assert.match(issue.title, /zram/);
  // It must report the RAM actually consumed, never the pool percentage.
  assert.doesNotMatch(issue.title, /99%/);
});

test('an unmeasurable zram pool stays silent', () => {
  // The pool's RAM cost is already inside MemAvailable, so the memory rules
  // catch genuine pressure whether or not mm_stat could be read. Warning here
  // would reintroduce the always-on badge for a device that cannot be worn out.
  assert.deepEqual(swapIssues({
    ...base, swapPct: 99, swapUsed: GB,
    swapBacking: 'zram', swapDevices: ['/dev/zram0'], zramRamBytes: null
  }), []);
});

test('a swapfile on disk still warns, unchanged', () => {
  const [issue] = swapIssues({
    ...base, swapPct: 60, swapUsed: GB,
    swapBacking: 'disk', swapDevices: ['/swapfile']
  });
  assert.equal(issue.level, 'warn');
  assert.match(issue.detail, /SD card/);
});

test('mixed backing warns and names the disk device', () => {
  const [issue] = swapIssues({
    ...base, swapPct: 60, swapUsed: GB,
    swapBacking: 'mixed', swapDevices: ['/dev/zram0', '/swapfile'], zramRamBytes: 2 ** 24
  });
  assert.equal(issue.level, 'warn');
  assert.match(issue.detail, /\/swapfile/);
});

test('an unreadable /proc/swaps warns rather than assuming zram', () => {
  // Not knowing what backs the swap must never read as the harmless answer.
  const [issue] = swapIssues({
    ...base, swapPct: 60, swapUsed: GB, swapBacking: null, swapDevices: []
  });
  assert.equal(issue.level, 'warn');
  assert.match(issue.detail, /proc\/swaps/);
});

test('below the threshold nothing is raised whatever the backing', () => {
  for (const swapBacking of ['zram', 'disk', 'mixed', null]) {
    assert.deepEqual(swapIssues({
      ...base, swapPct: 10, swapUsed: 2 ** 28, swapBacking, swapDevices: ['/swapfile']
    }), [], `backing ${swapBacking}`);
  }
});
