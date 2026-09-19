/* VARNOX native notification bridge.
 *
 * The web app raises alerts with:
 *     new window.Notification(name, { body: text, tag: 'varnox-<id>' })
 * and gates its settings UI on `"Notification" in window` and
 * `Notification.requestPermission()`. Android WebView implements none of these, so the
 * app reports "Browser notifications are not supported here" and never alerts.
 *
 * This shim implements that API surface on top of the native NotificationManager through
 * the `VarnoxNative` JavaScript interface. Native decides whether to actually post (it
 * stays silent while the app is on screen), so the web app keeps ownership of *what* is
 * notification-worthy and the shell only renders it.
 */
(function () {
  if (window.__varnoxBridgeInstalled) return;
  window.__varnoxBridgeInstalled = true;

  var NATIVE = window.VarnoxNative || null;
  var HANDLERS = {};          // tag -> Notification instance (for onclick dispatch)
  var MAX_HANDLERS = 64;

  function nativePermission() {
    if (!NATIVE) return 'default';
    try {
      return NATIVE.hasNotificationPermission() ? 'granted' : 'default';
    } catch (e) {
      return 'default';
    }
  }

  function remember(tag, instance) {
    if (!tag) return;
    var keys = Object.keys(HANDLERS);
    if (keys.length >= MAX_HANDLERS) delete HANDLERS[keys[0]];
    HANDLERS[tag] = instance;
  }

  function VarnoxNotification(title, options) {
    options = options || {};
    var name = title === undefined || title === null ? 'VARNOX' : String(title);
    var body = options.body === undefined || options.body === null ? '' : String(options.body);
    var tag = options.tag === undefined || options.tag === null ? '' : String(options.tag);

    this.title = name;
    this.body = body;
    this.tag = tag;
    this.data = options.data || null;
    this.silent = !!options.silent;
    this.onclick = null;
    this.onclose = null;
    this.onshow = null;

    remember(tag, this);

    if (NATIVE) {
      try {
        if (NATIVE.hasNotificationPermission()) NATIVE.postNotification(name, body, tag);
      } catch (e) {
        /* never let a failed alert break the app */
      }
    }
  }

  VarnoxNotification.prototype.close = function () {
    if (this.tag) delete HANDLERS[this.tag];
  };

  Object.defineProperty(VarnoxNotification, 'permission', {
    configurable: true,
    get: function () {
      return nativePermission();
    }
  });

  VarnoxNotification.requestPermission = function (callback) {
    return new Promise(function (resolve) {
      var settled = false;

      function finish(state) {
        if (settled) return;
        settled = true;
        window.__varnoxNotificationPermissionResult = null;
        try {
          if (typeof callback === 'function') callback(state);
        } catch (e) { /* ignore app callback errors */ }
        resolve(state);
      }

      window.__varnoxNotificationPermissionResult = finish;

      if (nativePermission() === 'granted') {
        finish('granted');
        return;
      }
      if (!NATIVE) {
        finish('denied');
        return;
      }
      try {
        NATIVE.requestNotificationPermission();
      } catch (e) {
        finish('denied');
        return;
      }
      // native answers through __varnoxNotificationPermissionResult; give the user time
      setTimeout(function () {
        finish(nativePermission() === 'granted' ? 'granted' : 'denied');
      }, 30000);
    });
  };

  // Called by the shell when a notification is tapped, so the app's own onclick runs.
  window.__varnoxHandleNotificationClick = function (tag) {
    var handler = HANDLERS[tag];
    if (!handler) return false;
    try {
      if (typeof handler.onclick === 'function') handler.onclick({ target: handler });
    } catch (e) { /* ignore */ }
    return true;
  };

  window.Notification = VarnoxNotification;
  /**
   * A call is not an ordinary connection: audio has to survive the screen going off, and on
   * Android 14+ the foreground service must declare the microphone before it may capture it.
   * The shell handles both; the page only reports when a call starts and ends.
   */
  window.__varnoxCall = {
    setActive: function (active) {
      try {
        if (NATIVE && NATIVE.setCallActive) NATIVE.setCallActive(!!active);
      } catch (e) {
        /* the call itself is unaffected */
      }
    }
  };

})();
