// 起動・タブの切り替え・毎秒の更新
import { $, $$, store, onSave, haptic, toast } from './util.js';
import { engine } from './alarm.js';
import { renderAlarm, bindAlarm } from './alarm-ui.js';
import { renderTools, bindTools, bindStatus } from './home.js';
import { renderTrip, bindTrip, tickTrip, currentTrip } from './trip.js';
import { renderTransit, showTransitTab } from './transit.js';
import { renderSettings, applyTheme } from './settings.js';
import { checkReminders } from './tools.js';
import { startSocial, pushTrip, social } from './social.js';

store.load();

// iPhone のホーム画面から開いた時、画面の高さが短く計算されて下がずれることがあるので、実際の画面の高さを使う
function fitHeight() {
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  let h = window.innerHeight;
  if (standalone && screen.height && Math.abs(window.innerWidth - Math.min(screen.width, screen.height)) < 2) h = Math.max(h, screen.height);
  else if (standalone && screen.width && Math.abs(window.innerWidth - Math.max(screen.width, screen.height)) < 2) h = Math.max(h, Math.min(screen.width, screen.height));
  document.documentElement.style.setProperty('--app-h', h + 'px');
}
fitHeight();
addEventListener('resize', fitHeight);
addEventListener('orientationchange', () => setTimeout(fitHeight, 300));
applyTheme();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

let tab = 'trip';
const renders = { trip: renderTrip, alarm: renderAlarm, transit: renderTransit, tools: renderTools, settings: renderSettings };

function go(t, sub) {
  tab = t;
  $$('#tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  $$('.view').forEach((v) => v.classList.toggle('active', v.dataset.tab === t));
  if (t === 'transit' && sub) showTransitTab(sub); else renders[t]();
  $('#view-' + t).scrollTop = 0;
  updateNav();
}
$$('#tabbar button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.tab === tab) { $('#view-' + tab).scrollTo({ top: 0, behavior: 'smooth' }); return; }
  b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce');
  haptic(); go(b.dataset.tab);
}));

// iOS の小さいナビゲーションバー：大きい見出しが上に隠れたら、上に小さく見出しを出す
const navbar = document.createElement('div');
navbar.className = 'nav-small';
navbar.innerHTML = '<span></span>';
$('#app').append(navbar);
function updateNav() {
  const v = $('#view-' + tab);
  const h = v && $('.large-title h1', v);
  if (!h) { navbar.classList.remove('show'); return; }
  const top = h.getBoundingClientRect().bottom;
  // 上の余白（ノッチの分を含む）より上に見出しが隠れたら出す
  const show = top < (parseFloat(getComputedStyle(v).paddingTop) || 0) + 8;
  navbar.firstChild.textContent = tab === 'trip' ? (currentTrip()?.name || h.textContent) : h.textContent;
  navbar.classList.toggle('show', show);
}
$$('.view').forEach((v) => v.addEventListener('scroll', () => requestAnimationFrame(updateNav), { passive: true }));
navbar.onclick = () => $('#view-' + tab)?.scrollTo({ top: 0, behavior: 'smooth' });

bindStatus(go);
bindTools();
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
social.listeners.add(() => { if (tab === 'tools') renderTools(); });

// 毎秒：時計・旅程の「いま」・リマインド
setInterval(() => {
  if (tab === 'trip') tickTrip();
  const n = new Date();
  if (n.getSeconds() === 0) {
    checkReminders();
    if (tab === 'trip') renderTrip();
    if (tab === 'alarm') renderAlarm();
  }
}, 1000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { renders[tab](); checkReminders(); } });

go('trip');
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
