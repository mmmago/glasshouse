/**
 * test/test-remotekeys-webos11.js - On webOS 11 the compositor's key filters
 * are native, so the remote's keys are changed through LG's own values: the
 * streaming buttons through the settings service's other.mapping_info, Guide
 * and Home Hub through com.webos.keyaction.*, the ? button through LG's custom
 * button settings. LG's values are put back as they were, or as LG has since
 * sent them, LG's list is set again when LG writes its own back, and nothing
 * is put in the filter chain
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var rk = require('../server/lib/remotekeys');

console.log('Running test-remotekeys-webos11.js ...');

var dir = path.join(os.tmpdir(), 'tvweb-remotekeys-webos11-' + process.pid);
var stateDir = path.join(dir, 'state');
fs.mkdirSync(dir);
fs.mkdirSync(stateDir);
fs.writeFileSync(path.join(stateDir, 'country'), 'de\n');
var MAP = path.join(stateDir, 'remotekeys.json');
var LG_FILE = path.join(stateDir, 'remotekeys-lg.json');

function copy(v) { return JSON.parse(JSON.stringify(v)); }

// As a C5 on webOS 11.2.0 has them, shortened.
var MAPPING = [
  { movies: { launch_param: { activateType: 'search' }, app_id: 'com.webos.app.voice', isActive: true } },
  { netflix: { launch_param: null, app_id: 'netflix', isActive: true } },
  { amazon: { launch_param: null, app_id: 'amazon', isActive: true } },
  { ivi: { launch_param: null, app_id: 'ivi', isActive: false } },
  { disneyplus: { launch_param: { handledBy: 'app' }, app_id: 'com.disney.disneyplus-prod', isActive: true } },
  { rakutentv: { launch_param: null, app_id: 'ui30', isActive: false } },
  { hulu: { launch_param: null, app_id: 'jp.happyon.app', isActive: true } },
  { apps: { launch_param: null, app_id: 'com.webos.app.discovery', isActive: true } }
];
var SHORT = { id: 'com.webos.app.quickinputpicker', type: 'app', params: { quickMode: false } };
var LONG = { id: 'com.webos.app.accessibility-overlay', type: 'app', params: { quickMode: true } };
var INPUT_HUB = { action: 'launch', id: 'com.webos.app.homeconnect-overlay' };
var TV_GUIDE = { action: 'launch', fgAppIdsForByPass: ['com.webos.app.livetv', 'com.webos.app.hdmi1'], id: 'com.webos.app.livemenu' };
var LEGACY_CHAIN = [{ file: '/usr/lib/qt5/qml/KeyFilters/appLaunch.js', handler: 'handleHotkeys' }];
var APPS = [
  { id: 'youtube.leanback.v4', title: 'YouTube', visible: true },
  { id: 'netflix', title: 'Netflix', visible: true },
  { id: 'com.webos.app.livetv', title: 'Live TV', visible: true }
];

var tv;
function freshTv() {
  tv = {
    mapping: copy(MAPPING),
    custom: { customShortPress: copy(SHORT), customLongPress: copy(LONG) },
    configs: {
      'com.webos.surfacemanager.keyFiltersCpp': [{ file: '/usr/lib/libappLaunch.so', handler: 'handleHotkeys' }],
      'com.webos.surfacemanager.keyFilters': copy(LEGACY_CHAIN),
      'com.webos.keyaction.tvGuide': copy(TV_GUIDE),
      'com.webos.keyaction.inputHub': copy(INPUT_HUB)
    },
    mappingWrites: 0,
    customWrites: 0,
    configWrites: []
  };
}
freshTv();

function luna(uri, params, cb) {
  var r = { returnValue: true };
  if (uri === 'com.webos.service.config/getConfigs') {
    r.configs = {};
    params.configNames.forEach(function (n) { if (tv.configs[n] !== undefined) r.configs[n] = copy(tv.configs[n]); });
  } else if (uri === 'com.webos.service.config/setConfigs') {
    Object.keys(params.configs).forEach(function (n) {
      tv.configs[n] = copy(params.configs[n]);
      tv.configWrites.push(n);
    });
  } else if (uri === 'com.webos.settingsservice/getSystemSettings') {
    assert.strictEqual(params.category, 'other');
    r.settings = {};
    params.keys.forEach(function (k) {
      if (k === 'mapping_info') r.settings[k] = copy(tv.mapping);
      else if (tv.custom[k]) r.settings[k] = copy(tv.custom[k]);
    });
  } else if (uri === 'com.webos.settingsservice/setSystemSettings') {
    assert.strictEqual(params.category, 'other');
    Object.keys(params.settings).forEach(function (k) {
      if (k === 'mapping_info') { tv.mapping = copy(params.settings[k]); tv.mappingWrites++; } else { tv.custom[k] = copy(params.settings[k]); tv.customWrites++; }
    });
  } else if (uri === 'com.webos.applicationManager/listApps') {
    r.apps = APPS;
  } else {
    throw new Error('unexpected call ' + uri);
  }
  process.nextTick(function () { cb(r); });
}

// The settings service subscription, as luna.Subscription: its handler is kept
// so a test can hand it a change, as the service would.
var subs = [];
function Subscription(uri, payload, appId, handlers) {
  this.uri = uri; this.payload = payload; this.handlers = handlers; this.running = false;
  subs.push(this);
}
Subscription.prototype.start = function () { this.running = true; };
Subscription.prototype.stop = function () { this.running = false; };
function liveSubs() { return subs.filter(function (x) { return x.running; }); }

// No KeyFilters directory, as on the TV.
var initOpts = { luna: luna, subscription: Subscription, reapplyDelayMs: 5, powerRechecksMs: [30, 120], inputNames: { hdmi2: 'Apple TV' }, stateDir: stateDir, filtersDir: path.join(dir, 'KeyFilters') };
rk.init(initOpts);

function exists(p) { try { fs.statSync(p); return true; } catch (e) { return false; } }
function entry(name) {
  for (var i = 0; i < tv.mapping.length; i++) if (tv.mapping[i][name]) return tv.mapping[i][name];
  return undefined;
}
function set(key, action, id, next) {
  rk.setRemoteKey(key, action, id, function (r) {
    assert.ok(r.ok, key + ' ' + action + ': ' + r.error);
    next();
  });
}

var steps = [];
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function run(i) {
  if (i === steps.length) return done();
  try {
    steps[i].fn(function () { console.log('  ✓ ' + steps[i].name); run(i + 1); });
  } catch (e) {
    console.error('  ✗ ' + steps[i].name + '\n' + (e.stack || e));
    process.exit(1);
  }
}

step('offers Guide and the streaming buttons LG has switched on, with no filter chain', function (next) {
  rk.getRemoteKeys(function (r) {
    assert.ok(r.supported);
    assert.strictEqual(r.inChain, false);
    var keys = r.keys.map(function (k) { return k.key; });
    assert.deepEqual(keys, ['netflix', 'amazon', 'disneyplus', 'hulu', 'apps', 'homehub', 'multikey', 'multikeyhold', 'guide']);
    var multi = r.keys.filter(function (k) { return k.key === 'multikey'; })[0];
    assert.strictEqual(multi.noNothing, true);
    assert.strictEqual(r.keys[0].noNothing, undefined);
    r.keys.forEach(function (k) { assert.strictEqual(k.action, 'lg'); });
    // Hulu is only on remotes sold in the US.
    assert.ok(r.keys.filter(function (k) { return k.key === 'hulu'; })[0].elsewhere);
    next();
  });
});

step('a streaming button opens another app, and only its own entry changes', function (next) {
  set('netflix', 'open', 'youtube.leanback.v4', function () {
    assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true });
    assert.deepEqual(entry('amazon'), MAPPING[2].amazon);
    assert.strictEqual(tv.mapping.length, MAPPING.length);
    var lg = JSON.parse(fs.readFileSync(LG_FILE, 'utf8'));
    assert.deepEqual(lg.mapping.netflix, MAPPING[1].netflix);
    assert.deepEqual(tv.configs['com.webos.surfacemanager.keyFilters'], LEGACY_CHAIN);
    assert.strictEqual(tv.configs['glasshouse.remoteKeys'], undefined);
    rk.getRemoteKeys(function (r) {
      var k = r.keys.filter(function (x) { return x.key === 'netflix'; })[0];
      assert.strictEqual(k.action, 'open');
      assert.strictEqual(k.opens, 'YouTube');
      next();
    });
  });
});

step('Nothing switches the button off, keeping LG\'s app; As LG has it puts the entry back as it was', function (next) {
  set('netflix', 'nothing', '', function () {
    assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'netflix', isActive: false });
    // Still offered while switched off here.
    rk.getRemoteKeys(function (r) {
      assert.strictEqual(r.keys.filter(function (x) { return x.key === 'netflix'; })[0].action, 'nothing');
      set('netflix', 'lg', '', function () {
        assert.deepEqual(tv.mapping, MAPPING);
        assert.ok(!exists(LG_FILE));
        next();
      });
    });
  });
});

step('Guide opens an input through its key action, and goes back to LG\'s with the inputs it passes on', function (next) {
  set('guide', 'open', 'com.webos.app.hdmi2', function () {
    assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], { action: 'launch', id: 'com.webos.app.hdmi2' });
    assert.strictEqual(tv.mappingWrites, 3);
    set('guide', 'nothing', '', function () {
      assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], { action: 'ignore', accept: true });
      set('guide', 'lg', '', function () {
        assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
        next();
      });
    });
  });
});

step('a key this TV does not have, or LG has switched off, is refused', function (next) {
  rk.setRemoteKey('red', 'nothing', '', function (r) {
    assert.ok(!r.ok);
    rk.setRemoteKey('rakutentv', 'nothing', '', function (r2) {
      assert.ok(!r2.ok);
      next();
    });
  });
});

step('when LG sends its list again, the key is set again, and As LG has it keeps LG\'s new entry', function (next) {
  set('amazon', 'open', 'netflix', function () {
    var resent = copy(MAPPING);
    resent[2].amazon = { launch_param: { source: 'remote' }, app_id: 'amazon', isActive: true };
    tv.mapping = copy(resent);
    rk.recheckNative(function (ok) {
      assert.ok(ok);
      assert.deepEqual(entry('amazon'), { launch_param: null, app_id: 'netflix', isActive: true });
      var writes = tv.mappingWrites;
      rk.recheckNative(function () {
        assert.strictEqual(tv.mappingWrites, writes, 'nothing written when all is in place');
        set('amazon', 'lg', '', function () {
          assert.deepEqual(tv.mapping, resent);
          next();
        });
      });
    });
  });
});

step('Home Hub opens an app or nothing through its key action, and goes back to LG\'s', function (next) {
  set('homehub', 'open', 'youtube.leanback.v4', function () {
    assert.deepEqual(tv.configs['com.webos.keyaction.inputHub'], { action: 'launch', id: 'youtube.leanback.v4' });
    set('homehub', 'nothing', '', function () {
      assert.deepEqual(tv.configs['com.webos.keyaction.inputHub'], { action: 'ignore', accept: true });
      set('homehub', 'lg', '', function () {
        assert.deepEqual(tv.configs['com.webos.keyaction.inputHub'], INPUT_HUB);
        next();
      });
    });
  });
});

step('the ? button and its hold open an app through LG\'s custom button, cannot do nothing, and go back to LG\'s', function (next) {
  set('multikey', 'open', 'com.webos.app.hdmi2', function () {
    set('multikeyhold', 'open', 'youtube.leanback.v4', function () {
      assert.deepEqual(tv.custom.customShortPress, { id: 'com.webos.app.hdmi2', type: 'app', params: {} });
      assert.deepEqual(tv.custom.customLongPress, { id: 'youtube.leanback.v4', type: 'app', params: {} });
      rk.setRemoteKey('multikey', 'nothing', '', function (r) {
        assert.ok(!r.ok);
        assert.deepEqual(tv.custom.customShortPress, { id: 'com.webos.app.hdmi2', type: 'app', params: {} });
        set('multikey', 'lg', '', function () {
          set('multikeyhold', 'lg', '', function () {
            assert.deepEqual(tv.custom, { customShortPress: SHORT, customLongPress: LONG });
            assert.ok(!exists(LG_FILE));
            next();
          });
        });
      });
    });
  });
});

step('LG\'s list written back at standby is set again within moments, and the watch ends with nothing set', function (next) {
  assert.strictEqual(liveSubs().length, 0);
  set('netflix', 'open', 'youtube.leanback.v4', function () {
    var live = liveSubs();
    assert.strictEqual(live.length, 1);
    assert.strictEqual(live[0].uri, 'com.webos.settingsservice/getSystemSettings');
    assert.ok(live[0].payload.subscribe);
    // As the TV goes into standby.
    tv.mapping = copy(MAPPING);
    live[0].handlers.message({ settings: { mapping_info: copy(MAPPING) } });
    setTimeout(function () {
      assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true });
      set('netflix', 'lg', '', function () {
        assert.deepEqual(tv.mapping, MAPPING);
        assert.strictEqual(liveSubs().length, 0);
        next();
      });
    }, 50);
  });
});

step('LG\'s list written back at a power change with nothing announced is set again by the checks after it', function (next) {
  set('netflix', 'open', 'youtube.leanback.v4', function () {
    var before = copy(tv.mapping);
    // As the TV comes back on: LG's entries, and no message to the subscriber.
    tv.mapping = copy(MAPPING);
    rk.powerChanged();
    setTimeout(function () {
      assert.deepEqual(entry('netflix'), { launch_param: null, app_id: 'youtube.leanback.v4', isActive: true });
      // A second write later is caught by the next check.
      tv.mapping = copy(MAPPING);
      setTimeout(function () {
        assert.deepEqual(tv.mapping, before);
        set('netflix', 'lg', '', next);
      }, 120);
    }, 70);
  });
});

step('LG writing its list back again and again is answered twelve times a minute at most', function (next) {
  rk.init(initOpts);
  set('amazon', 'open', 'netflix', function () {
    var sub = liveSubs()[0];
    var rounds = 0;
    var writes = tv.mappingWrites;
    (function round() {
      if (rounds === 14) {
        assert.strictEqual(tv.mappingWrites - writes, 12);
        return set('amazon', 'lg', '', next);
      }
      rounds++;
      tv.mapping = copy(MAPPING);
      sub.handlers.message({});
      setTimeout(round, 30);
    })();
  });
});

step('the JavaScript filter leaves out the keys only webOS 11 offers', function (next) {
  var src = rk.filterSource();
  ['homehub', 'multikey', 'multikeyhold'].forEach(function (k) { assert.strictEqual(src.indexOf('"' + k + '"'), -1); });
  next();
});

step('restore puts back every key LG had, and deletes Glasshouse\'s files', function (next) {
  freshTv();
  set('disneyplus', 'open', 'youtube.leanback.v4', function () {
    set('guide', 'nothing', '', function () {
     set('multikeyhold', 'open', 'netflix', function () {
      assert.ok(exists(MAP) && exists(LG_FILE));
      rk.restore(function (ok) {
        assert.ok(ok);
        assert.deepEqual(tv.mapping, MAPPING);
        assert.deepEqual(tv.custom, { customShortPress: SHORT, customLongPress: LONG });
        assert.strictEqual(liveSubs().length, 0);
        assert.deepEqual(tv.configs['com.webos.keyaction.tvGuide'], TV_GUIDE);
        assert.deepEqual(tv.configs['com.webos.surfacemanager.keyFilters'], LEGACY_CHAIN);
        assert.ok(!exists(MAP) && !exists(LG_FILE));
        assert.strictEqual(tv.configs['glasshouse.remoteKeys'], undefined);
        next();
      });
     });
    });
  });
});

step('with no key ever set, the start and the recheck write nothing', function (next) {
  freshTv();
  rk.ensure(function (ok) {
    assert.ok(ok);
    rk.recheckNative(function () {
      assert.strictEqual(tv.mappingWrites, 0);
      assert.strictEqual(tv.customWrites, 0);
      assert.deepEqual(tv.configWrites, []);
      assert.strictEqual(liveSubs().length, 0);
      next();
    });
  });
});

step('a TV without native filters is not offered keys this way', function (next) {
  delete tv.configs['com.webos.surfacemanager.keyFiltersCpp'];
  rk.init({ luna: luna, subscription: Subscription, inputNames: {}, stateDir: stateDir, filtersDir: path.join(dir, 'KeyFilters') });
  rk.getRemoteKeys(function (r) {
    assert.strictEqual(r.supported, false);
    next();
  });
});

function done() {
  try { fs.readdirSync(stateDir).forEach(function (f) { fs.unlinkSync(path.join(stateDir, f)); }); } catch (e) {}
  try { fs.rmdirSync(stateDir); fs.rmdirSync(dir); } catch (e) {}
  console.log('test-remotekeys-webos11.js passed');
}

run(0);
