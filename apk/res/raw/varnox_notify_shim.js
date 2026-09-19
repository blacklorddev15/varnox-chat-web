/*
 * Injected before the web app boots.
 *
 * Android WebView implements neither the Web Notifications API nor the Web Push
 * API, so the app's own feature detection ("Notification" in window) reports
 * "not supported" and its notification toggle is a dead end. This shim defines
 * window.Notification and forwards every call to the native Android notification
 * channel through the VarnoxNotify JS interface.
 */
(function () {
  if (window.__varnoxNotifyShim) {
    return;
  }
  var bridge = window.VarnoxNotify;
  if (!bridge) {
    return;
  }
  window.__varnoxNotifyShim = true;

  var waiters = [];

  function currentPermission() {
    var state = 'default';
    try {
      state = String(bridge.permission() || 'default');
    } catch (e) {
      state = 'default';
    }
    return state;
  }

  function settle(state) {
    var list = waiters;
    waiters = [];
    for (var i = 0; i < list.length; i++) {
      try {
        list[i](state);
      } catch (e) {
        /* ignore listener errors */
      }
    }
    try {
      VarnoxNotification.permission = state;
    } catch (e) {
      /* ignore */
    }
  }

  /* Called from native once the OS dialog / settings detour resolves. */
  window.__varnoxNotifyPermission = function (state) {
    settle(String(state || 'default'));
  };

  function safeUrl() {
    try {
      return String(window.location.href);
    } catch (e) {
      return '';
    }
  }

  function VarnoxNotification(title, options) {
    options = options || {};
    var self = this;
    this.title = title == null ? '' : String(title);
    this.body = options.body == null ? '' : String(options.body);
    this.tag = options.tag == null ? '' : String(options.tag);
    this.data = options.data;
    this.dir = 'auto';
    this.lang = '';
    this.icon = options.icon == null ? '' : String(options.icon);
    this.silent = !!options.silent;
    this.onclick = null;
    this.onclose = null;
    this.onshow = null;
    this.onerror = null;

    this.close = function () {
      try {
        bridge.cancel(self.tag);
      } catch (e) {
        /* ignore */
      }
      if (typeof self.onclose === 'function') {
        try {
          self.onclose();
        } catch (e) {
          /* ignore */
        }
      }
    };

    if (currentPermission() !== 'granted') {
      if (typeof self.onerror === 'function') {
        setTimeout(function () {
          self.onerror(new Error('Notification permission not granted'));
        }, 0);
      }
      return;
    }

    try {
      bridge.post(self.title, self.body, self.tag, safeUrl());
    } catch (e) {
      if (typeof self.onerror === 'function') {
        setTimeout(function () {
          self.onerror(e);
        }, 0);
      }
      return;
    }
    setTimeout(function () {
      if (typeof self.onshow === 'function') {
        try {
          self.onshow();
        } catch (e) {
          /* ignore */
        }
      }
    }, 0);
  }

  VarnoxNotification.permission = currentPermission();
  VarnoxNotification.maxActions = 0;

  VarnoxNotification.requestPermission = function (callback) {
    var state = currentPermission();
    if (state === 'granted') {
      VarnoxNotification.permission = state;
      if (typeof callback === 'function') {
        callback(state);
      }
      return Promise.resolve(state);
    }
    var promise = new Promise(function (resolve) {
      waiters.push(resolve);
    });
    if (typeof callback === 'function') {
      waiters.push(function (s) {
        callback(s);
      });
    }
    try {
      bridge.requestPermission();
    } catch (e) {
      settle('denied');
    }
    return promise;
  };

  try {
    Object.defineProperty(window, 'Notification', {
      value: VarnoxNotification,
      writable: true,
      configurable: true
    });
  } catch (e) {
    window.Notification = VarnoxNotification;
  }

  /* Notifications raised through a service worker registration are routed
   * through the same native channel. */
  try {
    var Proto = window.ServiceWorkerRegistration && window.ServiceWorkerRegistration.prototype;
    if (Proto && !Proto.__varnoxPatched) {
      Proto.__varnoxPatched = true;
      Proto.showNotification = function (title, options) {
        try {
          new VarnoxNotification(title, options || {});
        } catch (e) {
          /* ignore */
        }
        return Promise.resolve();
      };
      Proto.getNotifications = function () {
        return Promise.resolve([]);
      };
    }
  } catch (e) {
    /* ignore */
  }

  /* Keep the exposed state fresh when the app reads it after a settings trip. */
  try {
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) {
        VarnoxNotification.permission = currentPermission();
      }
    });
  } catch (e) {
    /* ignore */
  }
})();
