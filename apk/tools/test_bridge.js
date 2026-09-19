/* Exercises res/raw/varnox_bridge.js against a mock VarnoxNative, including the exact
   guard sequence the VARNOX web app uses before raising an alert. */
const fs = require('fs');
const vm = require('vm');

const BRIDGE = require('path').join(__dirname, '..', 'res', 'raw', 'varnox_bridge.js');

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (detail ? '  -> ' + detail : '')); }
}

function loadBridge({ nativeGranted = false, nativePresent = true } = {}) {
  const calls = { posted: [], requestPermission: 0 };
  const state = { granted: nativeGranted };
  const window = { Promise, setTimeout, Object, String };
  if (nativePresent) {
    window.VarnoxNative = {
      hasNotificationPermission: () => state.granted,
      requestNotificationPermission: () => { calls.requestPermission++; },
      postNotification: (t, b, tag) => { calls.posted.push({ title: t, body: b, tag }); },
    };
  }
  const ctx = vm.createContext({ window, Promise, setTimeout, console });
  vm.runInContext(fs.readFileSync(BRIDGE, 'utf8'), ctx, { filename: 'varnox_bridge.js' });
  return { window, calls, setGranted: (v) => { state.granted = v; } };
}

console.log('\n1. API surface the web app probes');
{
  const { window } = loadBridge();
  check("'Notification' in window", 'Notification' in window);
  check('typeof Notification === function', typeof window.Notification === 'function');
  check('permission is a string', typeof window.Notification.permission === 'string',
        window.Notification.permission);
  check('requestPermission is callable', typeof window.Notification.requestPermission === 'function');
}

console.log('\n2. the app\'s alert call reaches native');
{
  const { window, calls } = loadBridge({ nativeGranted: true });
  const n = new window.Notification('Alice', { body: 'hey there', tag: 'varnox-42' });
  check('postNotification called once', calls.posted.length === 1, JSON.stringify(calls.posted));
  check('title passed through', calls.posted[0] && calls.posted[0].title === 'Alice');
  check('body passed through', calls.posted[0] && calls.posted[0].body === 'hey there');
  check('tag passed through', calls.posted[0] && calls.posted[0].tag === 'varnox-42');

  let clicked = false;
  n.onclick = () => { clicked = true; };
  const handled = window.__varnoxHandleNotificationClick('varnox-42');
  check('tap dispatches the app onclick handler', clicked && handled === true);

  const miss = new window.Notification('Bob', { body: 'x', tag: 'varnox-43' });
  miss.onclick = () => { throw new Error('wrong notification dispatched'); };
  const ok = window.__varnoxHandleNotificationClick('varnox-42');
  check('unrelated tag does not cross-dispatch', ok === true);
}

console.log('\n3. no alerts before the user grants permission');
{
  const { window, calls } = loadBridge({ nativeGranted: false });
  check("permission reads 'default'", window.Notification.permission === 'default',
        window.Notification.permission);
  new window.Notification('Alice', { body: 'hidden', tag: 'varnox-44' });
  check('nothing posted while ungranted', calls.posted.length === 0);
  check('handler still registered for later tap',
        window.__varnoxHandleNotificationClick('varnox-44') === true);
}

console.log('\n4. permission request round trip (app settings toggle)');
{
  const { window, calls, setGranted } = loadBridge({ nativeGranted: false });
  let resolved = null;
  const p = window.Notification.requestPermission().then((s) => { resolved = s; });
  check('native permission dialog triggered', calls.requestPermission === 1);
  check('promise pending until native answers', resolved === null);
  setGranted(true);   // the OS grants it, then the shell reports the result back
  window.__varnoxNotificationPermissionResult('granted');
  p.then(() => {
    check("promise resolves 'granted'", resolved === 'granted', String(resolved));
    check("permission now 'granted'", window.Notification.permission === 'granted');
    const { window: w2, calls: c2 } = loadBridge({ nativeGranted: true });
    c2.posted.length = 0;
    new w2.Notification('Carol', { body: 'after grant', tag: 'varnox-45' });
    check('alerts post once granted', c2.posted.length === 1);

    console.log('\n5. no native layer (defensive)');
    const { window: w3 } = loadBridge({ nativePresent: false });
    let threw = null;
    try { new w3.Notification('X', { body: 'y', tag: 'z' }); } catch (e) { threw = e; }
    check('constructing without native does not throw', threw === null, threw && threw.message);
    check("permission is 'default' without native", w3.Notification.permission === 'default');

    console.log('\n6. exactly the guard sequence the web app runs');
    {
      const { window: w4, calls: c4 } = loadBridge({ nativeGranted: true });
      // from the bundle: ze() -> if("Notification" in window) ... requestPermission()
      function appEnableNotifications() {
        if (typeof window === 'undefined' || !('Notification' in w4)) {
          return { ok: false, message: 'Browser notifications are not supported here' };
        }
        return w4.Notification.requestPermission().then((permission) => ({
          ok: permission === 'granted',
          message: permission === 'granted'
            ? 'Browser notifications enabled' : 'Notification permission was not granted',
        }));
      }
      // from the bundle: the new-message effect body
      function appAlert(message, conversation) {
        const permission = w4.Notification.permission;
        if (permission !== 'granted') return false;
        const body = message.body || message.mediaName || 'You received a new message';
        new w4.Notification(conversation || 'Varnox Chat', { body, tag: 'varnox-' + message.id });
        return true;
      }

      const alertFired = appAlert({ id: 7, body: 'ping from the app logic' }, 'Alice');
      check('app effect raises the alert', alertFired === true);
      check('native received the app-authored alert',
            c4.posted.length === 1 && c4.posted[0].body === 'ping from the app logic',
            JSON.stringify(c4.posted));

      appEnableNotifications().then((r) => {
        check('app settings path reports "enabled"', r.ok === true, JSON.stringify(r));
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
      });
    }
  });
}
