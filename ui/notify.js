// Notifications when a followed show has a new episode: the card in Settings that signs this
// device up with its browser's push service and tells the server (server/push.mjs), and what a
// tapped notification opens. The service worker shows them (coi-sw.js).
import { h, icon } from './dom.js';

const IS_IOS = typeof navigator !== 'undefined' && (/iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

// A tapped notification, with the app already open: the worker says where to go.
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open' && /^#\/[\w/-]*$/.test(e.data.hash || '')) location.hash = e.data.hash;
  });
  try { navigator.serviceWorker.startMessages(); } catch {}
}

const keyBytes = (b64) => Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const sameKey = (buf, bytes) => !!buf && buf.byteLength === bytes.length && new Uint8Array(buf).every((b, i) => b === bytes[i]);

// Why this device can't have notifications, in a sentence that says what to do; '' if it can.
function blocked(store) {
  const { server } = store;
  if (!server.there) return 'This copy of the app has no server behind it, so nothing can send it notifications.';
  if (server.offline) return 'The server is not answering right now. Try again when it is back.';
  if (!server.linked) return 'Link this device to your library first, under Your library below.';
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return 'This browser cannot get notifications from the app.';
  if (!('PushManager' in window) || !('Notification' in window)) {
    if (IS_IOS && !navigator.standalone) return 'Add the app to the home screen to get notifications. In Safari, tap Share, then Add to Home Screen, and open it from there.';
    return IS_IOS ? 'Notifications need iOS 16.4 or later. Update the iPhone, then try again.' : 'This browser cannot get notifications from the app.';
  }
  try {
    const off = JSON.parse(localStorage.getItem('pod-no-worker') || 'null');
    if (off && off.v === window.__workerVersion && Date.now() - off.at < 3 * 864e5) return 'The app\'s service worker is off on this device after a start that failed, and notifications come through it. It is tried again within three days.';
  } catch {}
  if (Notification.permission === 'denied') {
    return IS_IOS ? 'Notifications are turned off for this app. Turn them on in the iPhone\'s Settings, under Notifications, then switch them on here.'
      : 'Notifications are blocked for this site. Allow them in the browser\'s site settings, then switch them on here.';
  }
  return '';
}

// pod: the screens (ui/pod.js), for its store and toast.
export function notifyCard(pod) {
  const { store, toast } = pod;
  const ON = 'New episodes of the shows you follow show up on this device. A show can be left out on its own page.';
  const OFF = 'A notification on this device when a show you follow has a new episode.';
  const input = h('input', { type: 'checkbox', disabled: true });
  const hint = h('p.hint', { text: 'Checking this device…' });
  const actions = h('div.actions.hidden');
  let reg = null;
  let key = null;

  const draw = (on, text) => {
    input.checked = on;
    hint.textContent = text;
    actions.classList.toggle('hidden', !on);
  };

  const check = async () => {
    const why = blocked(store);
    if (why) { draw(false, why); return; }
    try {
      reg = await navigator.serviceWorker.getRegistration();
      if (!reg?.pushManager) { draw(false, 'The app\'s service worker is not running on this device yet. Close the app, open it again, and try once more.'); return; }
      const sub = await reg.pushManager.getSubscription();
      const got = await store.api('GET', `push${sub ? `?endpoint=${encodeURIComponent(sub.endpoint)}` : ''}`);
      key = keyBytes(got.key);
      input.disabled = false;
      draw(!!sub && got.known, sub && got.known ? ON : OFF);
    } catch (err) {
      draw(false, `Couldn't check with the server (${err.message}). Try again in a minute.`);
    }
  };

  const on = async () => {
    // Asked for in the tap itself: Safari only asks while one is going on.
    const asked = Notification.permission === 'granted' ? Promise.resolve('granted') : Notification.requestPermission();
    input.disabled = true;
    try {
      if ((await asked) !== 'granted') {
        draw(false, blocked(store) || 'Notifications were not allowed. Switch this on again to be asked once more.');
        return;
      }
      let sub = await reg.pushManager.getSubscription();
      // One made for another key (a server that started over) can't be sent to.
      if (sub && !sameKey(sub.options?.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await store.api('POST', 'push', { subscription: sub.toJSON() });
      draw(true, ON);
      toast('Notifications are on for this device');
    } catch (err) {
      draw(false, OFF);
      toast(`Couldn't switch notifications on: ${err.message}`);
    } finally {
      input.disabled = false;
    }
  };

  const off = async () => {
    input.disabled = true;
    try {
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await sub.unsubscribe().catch(() => {});
        await store.api('DELETE', `push?endpoint=${encodeURIComponent(sub.endpoint)}`);
      }
      draw(false, OFF);
      toast('Notifications are off for this device');
    } catch (err) {
      // (Unsubscribed here, the server stops on its own: the push service says the device is gone.)
      draw(false, OFF);
      toast(`Off on this device. The server hears of it the next time it sends (${err.message}).`);
    } finally {
      input.disabled = false;
    }
  };

  input.addEventListener('change', () => (input.checked ? on() : off()));
  actions.append(h('button.btn.ghost.small', { type: 'button', onclick: async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const sub = await reg.pushManager.getSubscription();
      if (!sub) throw new Error('This device is not signed up. Switch notifications off and on again.');
      await store.api('POST', 'push/test', { endpoint: sub.endpoint });
      toast('Sent. It shows up in a few seconds.');
    } catch (err) {
      toast(`Couldn't send it: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  } }, icon('check'), h('span', { text: 'Send a test notification' })));

  check();
  return h('section.card.pod-card', { id: 'settings-notify' },
    h('div.pod-head', {}, h('div', {}, h('p.kicker', { text: 'On this device' }), h('h2', { text: 'Notifications' }))),
    h('div.notify-body', {},
      h('label.switch.setting', {}, input, h('span.track', {}, h('span.knob')), h('span.switch-label', { text: 'Tell me when a new episode is out' })),
      hint, actions));
}
