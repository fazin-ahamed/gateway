// Stealth init script for the z.ai token harvester.
//
// Aliyun's device SDK will not mint a usable device token from a plainly
// automated browser: it reads navigator.webdriver, the plugin list,
// window.chrome, WebGL vendor strings and screen geometry, and refuses when
// they look headless. Injecting this before any page script runs is what makes
// the harvested tokens acceptable.
//
// Ported verbatim from GLM-Free-API's token collector (MIT), which reverse
// engineered the set of properties that matter. Placeholders are substituted by
// the harvester before injection:
//   __VER__  -> the bundled Chromium's major version
//
// Usage (Playwright): page.addInitScript({ content: buildStealthScript(version) })

export function buildStealthScript(chromeMajor) {
  return STEALTH_TEMPLATE.replace(/__VER__/g, String(chromeMajor || ""));
}

export const STEALTH_TEMPLATE = String.raw`(function () {
    'use strict';

    var patched = [];
    function track(fn) { patched.push(fn); return fn; }

    var ua = navigator.userAgent || '';
    var isWin = ua.indexOf('Windows NT') !== -1;
    var isMac = ua.indexOf('Macintosh') !== -1;
    var platOS = isWin ? 'Windows' : (isMac ? 'macOS' : 'Linux');
    var platNav = isWin ? 'Win32' : (isMac ? 'MacIntel' : 'Linux x86_64');

    // 1) navigator.webdriver → false (matches normal, non-automated Chrome)
    try {
        Object.defineProperty(Navigator.prototype, 'webdriver', {
            get: track(function webdriver() { return false; }),
            configurable: true,
        });
    } catch (e) {}

    // 2) language / languages
    try {
        Object.defineProperty(Navigator.prototype, 'languages', {
            get: track(function languages() { return ['en-US', 'en']; }),
            configurable: true,
        });
        Object.defineProperty(Navigator.prototype, 'language', {
            get: track(function language() { return 'en-US'; }),
            configurable: true,
        });
    } catch (e) {}

    // 3) platform — must agree with the UA's OS token
    try {
        Object.defineProperty(Navigator.prototype, 'platform', {
            get: track(function platform() { return platNav; }),
            configurable: true,
        });
    } catch (e) {}

    // 4) CPU / memory
    try {
        Object.defineProperty(Navigator.prototype, 'hardwareConcurrency', {
            get: track(function hardwareConcurrency() { return 8; }),
            configurable: true,
        });
        if (!('deviceMemory' in navigator)) {
            Object.defineProperty(Navigator.prototype, 'deviceMemory', {
                get: track(function deviceMemory() { return 8; }),
                configurable: true,
            });
        }
    } catch (e) {}

    // 5) plugins / mimeTypes — replicate a real Chrome install exactly
    try {
        var names = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer',
                     'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
        var file = 'internal-pdf-viewer';
        var desc = 'Portable Document Format';
        var mimeDefs = [
            { type: 'application/pdf', suffixes: 'pdf' },
            { type: 'text/pdf', suffixes: 'pdf' },
        ];
        var plugins = [];
        names.forEach(function (n) {
            var plugin = Object.create(Plugin.prototype);
            var mimes = mimeDefs.map(function (m) {
                var mt = Object.create(MimeType.prototype);
                Object.defineProperties(mt, {
                    type: { value: m.type, enumerable: true },
                    suffixes: { value: m.suffixes, enumerable: true },
                    description: { value: desc, enumerable: true },
                    enabledPlugin: { value: plugin, enumerable: true },
                });
                return mt;
            });
            Object.defineProperties(plugin, {
                name: { value: n, enumerable: true },
                filename: { value: file, enumerable: true },
                description: { value: desc, enumerable: true },
                length: { value: mimes.length, enumerable: true },
            });
            mimes.forEach(function (m, i) {
                Object.defineProperty(plugin, String(i), { value: m, enumerable: true });
            });
            plugin.item = track(function item(i) { return mimes[i] || null; });
            plugin.namedItem = track(function namedItem(nm) {
                for (var i = 0; i < mimes.length; i++) { if (mimes[i].type === nm) return mimes[i]; }
                return null;
            });
            plugins.push(plugin);
        });
        var pa = Object.create(PluginArray.prototype);
        Object.defineProperty(pa, 'length', { value: plugins.length, enumerable: true });
        plugins.forEach(function (p, i) {
            Object.defineProperty(pa, String(i), { value: p, enumerable: true });
        });
        pa.item = track(function item(i) { return plugins[i] || null; });
        pa.namedItem = track(function namedItem(nm) {
            for (var i = 0; i < plugins.length; i++) { if (plugins[i].name === nm) return plugins[i]; }
            return null;
        });
        pa.refresh = track(function refresh() {});
        Object.defineProperty(Navigator.prototype, 'plugins', {
            get: track(function plugins() { return pa; }),
            configurable: true,
        });

        var navMimes = [plugins[0][0], plugins[0][1]];
        var ma = Object.create(MimeTypeArray.prototype);
        Object.defineProperty(ma, 'length', { value: navMimes.length, enumerable: true });
        navMimes.forEach(function (m, i) {
            Object.defineProperty(ma, String(i), { value: m, enumerable: true });
        });
        ma.item = track(function item(i) { return navMimes[i] || null; });
        ma.namedItem = track(function namedItem(nm) {
            for (var i = 0; i < navMimes.length; i++) { if (navMimes[i].type === nm) return navMimes[i]; }
            return null;
        });
        Object.defineProperty(Navigator.prototype, 'mimeTypes', {
            get: track(function mimeTypes() { return ma; }),
            configurable: true,
        });
    } catch (e) {}

    // 6) window.chrome — absent in headless, present in every real Chrome
    try {
        if (!window.chrome) { window.chrome = {}; }
        if (!window.chrome.runtime) {
            window.chrome.runtime = {
                PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
                PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64', MIPS: 'mips', MIPS64: 'mips64' },
                connect: track(function connect() { return undefined; }),
                sendMessage: track(function sendMessage() { return undefined; }),
            };
        }
        if (!window.chrome.app) {
            window.chrome.app = {
                isInstalled: false,
                InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
                RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
                getDetails: track(function getDetails() { return null; }),
                getIsInstalled: track(function getIsInstalled() { return false; }),
                installState: track(function installState(cb) {
                    if (typeof cb === 'function') { cb('not_installed'); }
                }),
            };
        }
        if (!window.chrome.loadTimes) {
            window.chrome.loadTimes = track(function loadTimes() {
                var t = Date.now() / 1000;
                return {
                    requestTime: t, startLoadTime: t, commitLoadTime: t,
                    finishDocumentLoadTime: t, finishLoadTime: t, firstPaintTime: t,
                    firstPaintAfterLoadTime: 0, navigationType: 'Other',
                    wasFetchedViaSpdy: false, wasNpnNegotiated: true,
                    npnNegotiatedProtocol: 'h2', wasAlternateProtocolAvailable: false,
                    connectionInfo: 'h2',
                };
            });
        }
        if (!window.chrome.csi) {
            window.chrome.csi = track(function csi() {
                return { startE: Date.now(), onloadT: Date.now(), pageT: 10, tran: 15 };
            });
        }
    } catch (e) {}

    // 7) permissions.query — headless reports 'denied' for notifications
    try {
        if (window.navigator.permissions && window.navigator.permissions.query) {
            var oq = window.navigator.permissions.query.bind(window.navigator.permissions);
            window.navigator.permissions.query = track(function query(p) {
                if (p && p.name === 'notifications') {
                    return Promise.resolve({ state: 'default', onchange: null });
                }
                return oq(p);
            });
        }
    } catch (e) {}

    // 8) WebGL — headless leaks SwiftShader; fake a plausible GPU stack
    try {
        var vendor = isWin ? 'Google Inc. (Intel)' : (isMac ? 'Google Inc. (Apple)' : 'Google Inc. (Intel)');
        var renderer = isWin
            ? 'ANGLE (Intel, Intel(R) UHD Graphics 630 (D3D11), D3D11)'
            : (isMac
                ? 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)'
                : 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)');
        function patchGet(proto) {
            var orig = proto.getParameter;
            proto.getParameter = track(function getParameter(p) {
                if (p === 37445) { return vendor; }
                if (p === 37446) { return renderer; }
                return orig.apply(this, arguments);
            });
        }
        if (typeof WebGLRenderingContext !== 'undefined') { patchGet(WebGLRenderingContext.prototype); }
        if (typeof WebGL2RenderingContext !== 'undefined') { patchGet(WebGL2RenderingContext.prototype); }
    } catch (e) {}

    // 9) userAgentData — headless leaks a 'HeadlessChrome' brand
    try {
        if (navigator.userAgentData) {
            var uad = {
                brands: [
                    { brand: 'Chromium', version: '__VER__' },
                    { brand: 'Google Chrome', version: '__VER__' },
                    { brand: 'Not_A Brand', version: '24' },
                ],
                mobile: false,
                platform: platOS,
                getHighEntropyValues: track(function getHighEntropyValues(hints) {
                    return Promise.resolve({
                        architecture: 'x86',
                        bitness: '64',
                        model: '',
                        platform: platOS,
                        platformVersion: isWin ? '15.0.0' : (isMac ? '14.1.0' : '6.5.0'),
                        uaFullVersion: '__VER__.0.0.0',
                        fullVersionList: [
                            { brand: 'Chromium', version: '__VER__.0.0.0' },
                            { brand: 'Google Chrome', version: '__VER__.0.0.0' },
                            { brand: 'Not_A Brand', version: '24.0.0.0' },
                        ],
                    });
                }),
            };
            Object.defineProperty(Navigator.prototype, 'userAgentData', {
                get: track(function userAgentData() { return uad; }),
                configurable: true,
            });
        }
    } catch (e) {}

    // 10) window / screen geometry — headless reports a 0-sized outer window
    try {
        Object.defineProperty(window, 'outerWidth', {
            get: track(function outerWidth() { return 1920; }), configurable: true,
        });
        Object.defineProperty(window, 'outerHeight', {
            get: track(function outerHeight() { return 1160; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'width', {
            get: track(function width() { return 2560; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'height', {
            get: track(function height() { return 1440; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'availWidth', {
            get: track(function availWidth() { return 2560; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'availHeight', {
            get: track(function availHeight() { return 1400; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'colorDepth', {
            get: track(function colorDepth() { return 24; }), configurable: true,
        });
        Object.defineProperty(Screen.prototype, 'pixelDepth', {
            get: track(function pixelDepth() { return 24; }), configurable: true,
        });
    } catch (e) {}

    // 11) iframes — captcha SDKs check contentWindow.chrome cross-frame
    try {
        var d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
        if (d && d.get) {
            var og = d.get;
            Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
                get: track(function contentWindow() {
                    var w = og.call(this);
                    try {
                        if (w && !w.chrome && window.chrome) { w.chrome = window.chrome; }
                    } catch (e) {}
                    return w;
                }),
                configurable: true,
            });
        }
    } catch (e) {}

    // 12) Notification.permission
    try {
        if (typeof Notification !== 'undefined') {
            Object.defineProperty(Notification, 'permission', {
                get: track(function permission() { return 'default'; }),
                configurable: true,
            });
        }
    } catch (e) {}

    // 13) toString mask — every function patched above must report
    //     "[native code]" or the tampering itself becomes detectable.
    try {
        var origToString = Function.prototype.toString;
        var toStringProxy = new Proxy(origToString, {
            apply: function (target, thisArg, args) {
                if (thisArg && patched.indexOf(thisArg) !== -1) {
                    return 'function ' + (thisArg.name || '') + '() { [native code] }';
                }
                return Reflect.apply(target, thisArg, args);
            },
        });
        patched.push(toStringProxy);
        Function.prototype.toString = toStringProxy;
    } catch (e) {}
})();`;
