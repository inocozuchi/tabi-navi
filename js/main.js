// 起動・タブの切り替え・毎秒の更新
import { $, $$, store, onSave, haptic, toast } from './util.js';
import { engine } from './alarm.js';
import { renderAlarm, bindAlarm } from './alarm-ui.js';
import { renderHome, bindHome, tickHome } from './home.js';
import { renderTrip, bindTrip, tickTrip, currentTrip } from './trip.js';
import { renderTransit, showTransitTab } from './transit.js';
import { renderSettings, applyTheme } from './settings.js';
import { checkReminders } from './tools.js';
import { startSocial, pushTrip, social } from './social.js';

store.load();
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

let tab = 'home';
const renders = { home: renderHome, trip: renderTrip, alarm: renderAlarm, transit: renderTransit, settings: renderSettings };

function go(t, sub) {
  tab = t;
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.tab === t));
  if (t === 'transit' && sub) showTransitTab(sub); else renders[t]();
  $('#view-' + t).scrollTop = 0;
}
$$('#tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === tab) { $('#view-' + tab).scrollTo({ top: 0, behavior: 'smooth' }); return; }
  b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce');
  haptic(); go(b.dataset.tab);
}));

bindHome(go);
bindTrip();
bindAlarm();
engine.init();

// 旅程が変わったら、共有中のグループへ送る（他の端末から届いた変更は送り返さない）
const hashes = new Map();
const hashOf = (t) => JSON.stringify(t.items) + t.name;
onSave((remote) => {
  for (const t of store.data.trips) {
    const h = hashOf(t);
    if (hashes.get(t.id) !== h) {
      hashes.set(t.id, h);
      if (!remote && t.groupId) { t.updated = Date.now(); localStorage.setItem('tabinavi.v1', JSON.stringify(store.data)); pushTrip(t); }
    }
  }
});
for (const t of store.data.trips) hashes.set(t.id, hashOf(t));
social.listeners.add(() => { if (tab === 'home') renderHome(); });

// 毎秒：時計・旅程の「いま」・リマインド
setInterval(() => {
  if (tab === 'home') tickHome();
  if (tab === 'trip') tickTrip();
  const n = new Date();
  if (n.getSeconds() === 0) {
    checkReminders();
    if (tab === 'trip') renderTrip();
    if (tab === 'alarm') renderAlarm();
  }
}, 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { renders[tab](); checkReminders(); } });

go('home');
checkReminders();
startSocial();

// ロード画面
const t0 = performance.now();
window.addEventListener('load', () => {
  setTimeout(() => { $('#splash').classList.add('hide'); setTimeout(() => $('#splash').remove(), 700); }, Math.max(0, 1100 - (performance.now() - t0)));
});
setTimeout(() => $('#splash')?.classList.add('hide'), 4000);

// オフラインでも開けるように
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
window.addEventListener('offline', () => toast('オフラインです（旅程・メモ・アラームは使えます）'));
void currentTrip;
