import { getFirebaseStatus, watchConnection, watchTournament } from './db.js';
import { ACTIONS, describe, replay, standings } from './rules.js';

const root = document.body;
const matchQuery = new URLSearchParams(location.search).get('match');
const singleMatchMode = Boolean(matchQuery);
let data = {};
let connected = false;
let dataError = '';
let activeTab = 'home';
let searchTerm = '';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formatTime = value => {
  const date = Number(value);
  return Number.isFinite(date) && date > 0 ? new Date(date).toLocaleString('zh-TW', { hour12: false }) : '尚無資料';
};
const allMatches = () => Object.values(data.matches || {}).filter(match => match && match.id);
const teamById = id => data.teams?.[id] || { id: String(id || ''), name: String(id || '待定'), players: [] };
const teamName = id => teamById(id).name || String(id || '待定');
const matchTitle = match => `${teamName(match.teamAId)}　VS　${teamName(match.teamBId)}`;
const stageName = stage => stage === 'final' ? '決賽' : '循環賽';
const statusClass = status => status === '進行中' ? 'is-live' : status === '已結束' ? 'is-ended' : '';
const statusText = match => match.status || '未開始';

function eventRows(matchId) {
  const group = data.events?.[matchId];
  if (!group || typeof group !== 'object') return [];
  return Object.entries(group)
    .filter(([, event]) => event && typeof event === 'object')
    .map(([key, event]) => ({ key, ...event }))
    .sort((a, b) => (Number(a.sequence) - Number(b.sequence)) || (Number(a.timestamp) - Number(b.timestamp)) || a.key.localeCompare(b.key));
}

function matchActions(match) {
  const stored = eventRows(match.id).map(event => event.action).filter(action => action && typeof action.type === 'string');
  if (stored.length) return stored;
  const teamA = teamById(match.teamAId);
  const teamB = teamById(match.teamBId);
  return [{ type: ACTIONS.START_MATCH.type, teams: [{ id: String(teamA.id), name: String(teamA.name) }, { id: String(teamB.id), name: String(teamB.name) }] }];
}

function stateFor(match) {
  return replay(matchActions(match));
}

function sortedMatches() {
  return allMatches().sort((a, b) => {
    if (a.stage !== b.stage) return a.stage === 'roundRobin' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  });
}

function roundRobinMatchesForStandings() {
  return allMatches().filter(match => match.stage === 'roundRobin').map(match => ({
    phase: 'roundRobin',
    events: eventRows(match.id).map(event => event.action).filter(Boolean),
  }));
}

function currentStandings() {
  const teams = Object.values(data.teams || {}).map(team => ({ id: String(team.id), name: String(team.name) }));
  if (teams.length < 2) return [];
  try { return standings(teams, roundRobinMatchesForStandings()); } catch { return []; }
}

function scoreText(state, match) {
  const score = state.score || {};
  return `${score[match.teamAId] ?? 0} : ${score[match.teamBId] ?? 0}`;
}

function dotsMarkup(state) {
  const view = describe(state);
  return `<div class="series-dots">${view.progressDots.map(team => `<span class="team-progress"><span>${escapeHtml(team.teamName)}</span><span class="dots" aria-label="局數進度 ${team.dots.join('')}">${team.dots.join('')}</span></span>`).join('')}</div>`;
}

function gamesMarkup(state) {
  const view = describe(state);
  if (!view.gameResults.length) return '<div class="empty-state">尚未開打</div>';
  return `<div class="game-list">${view.gameResults.map(game => `<div class="game-row"><strong>第 ${game.gameNumber} 局</strong><div class="metric-line"><span>擊殺</span><span>${escapeHtml(game.killsText)}</span></div><div class="metric-line"><span>推塔</span><span>${escapeHtml(game.towersText)}</span></div><span class="${game.winnerTeamId ? 'game-winner' : 'game-pending'}">${escapeHtml(game.winnerText)}</span></div>`).join('')}</div>`;
}

function matchSummaryMarkup(match, { large = false, showLink = false } = {}) {
  const state = stateFor(match);
  const winner = state.winnerTeamId ? teamName(state.winnerTeamId) : '';
  const cls = large ? 'single-match-card' : 'live-match-card';
  return `<article class="${cls}">
    <div class="${large ? '' : 'live-head'}">
      <div><span class="match-stage">${escapeHtml(stageName(match.stage))}・${escapeHtml(match.id)}</span><h2 class="${large ? 'live-title' : 'live-title'}">${escapeHtml(matchTitle(match))}</h2><div class="match-meta"><span>${escapeHtml(match.venue || '場地未指定')}</span><span class="status-pill ${statusClass(statusText(match))}">${escapeHtml(statusText(match))}</span></div></div>
    </div>
    <div class="series-score"><span>${state.score?.[match.teamAId] ?? 0}</span><span class="score-separator">:</span><span>${state.score?.[match.teamBId] ?? 0}</span></div>
    ${dotsMarkup(state)}
    ${winner ? `<div class="winner-banner">系列賽勝方：${escapeHtml(winner)}</div>` : ''}
    ${gamesMarkup(state)}
    ${showLink ? `<div class="live-link-row"><a class="live-link" href="./index.html?match=${encodeURIComponent(match.id)}">開啟單場大字模式 ↗</a></div>` : ''}
  </article>`;
}

function scheduleMatchCard(match) {
  if (match.isPlaceholder) {
    return `<article class="schedule-card"><div class="schedule-top"><span class="match-stage">決賽</span><span class="status-pill">待定</span></div><h3 class="match-title">待定　VS　待定</h3><div class="match-meta"><span>循環賽結束後產生</span></div></article>`;
  }
  const state = stateFor(match);
  const ended = match.status === '已結束';
  const started = match.status !== '未開始';
  const result = started
    ? `<h3 class="match-title">${escapeHtml(matchTitle(match))}</h3><div class="series-score"><span>${state.score?.[match.teamAId] ?? 0}</span><span class="score-separator">:</span><span>${state.score?.[match.teamBId] ?? 0}</span></div>${ended ? `<p class="section-note">勝方：${escapeHtml(teamName(state.winnerTeamId))}</p>` : '<p class="section-note">目前系列賽比數</p>'}`
    : `<h3 class="match-title">${escapeHtml(matchTitle(match))}</h3>`;
  return `<article class="schedule-card"><div class="schedule-top"><span class="match-stage">${escapeHtml(stageName(match.stage))}・${escapeHtml(match.id)}</span><span class="status-pill ${statusClass(statusText(match))}">${escapeHtml(statusText(match))}</span></div>${result}<div class="match-meta"><span>${escapeHtml(match.venue || '場地未指定')}</span></div></article>`;
}

function renderHeader() {
  const eventName = data.meta?.eventName || '第 22 題〈電競三戰兩勝賽〉';
  document.querySelector('#event-name').textContent = eventName;
  document.querySelector('#hero-event-name').textContent = eventName.replace(/^第 22 題[〈「]?/, '').replace(/[〉」]?$/, '');
  const badge = document.querySelector('#connection-state');
  badge.className = `connection-badge ${connected ? 'is-online' : 'is-offline'}`;
  badge.innerHTML = `<span class="status-dot"></span>${connected ? '已連線' : '離線'}`;
  document.querySelector('#last-update').textContent = formatTime(data.meta?.lastUpdatedAt);
  const offlineNotice = document.querySelector('#offline-notice');
  offlineNotice.hidden = connected;
  offlineNotice.textContent = data.meta
    ? '目前離線，以下保留最後收到的資料，內容不是最新的。'
    : '目前離線，尚未收到賽事資料。';
  const firebaseStatus = getFirebaseStatus();
  const configNotice = document.querySelector('#config-notice');
  configNotice.hidden = firebaseStatus.configured && !dataError;
  if (!firebaseStatus.configured) configNotice.textContent = `Firebase 尚未設定：${firebaseStatus.message}`;
  else if (dataError) configNotice.textContent = `無法讀取 Firebase 資料：${dataError}`;
  const hasTournament = Boolean(data.matches && data.teams);
  document.querySelector('#global-empty').hidden = hasTournament;
}

function renderHome() {
  const entries = [
    ['賽程', '六場循環賽與決賽安排', '01', 'schedule'],
    ['場地', '查看兩個場地的即時狀態', '02', 'courts'],
    ['即時分數', '追蹤目前正在進行的對戰', '03', 'live'],
    ['成績', '查看已結束比賽的每局細節', '04', 'results'],
    ['排名', '勝場與小局勝負差排名', '05', 'standings'],
    ['查詢', '依隊名或選手名找比賽', '06', 'search'],
  ];
  document.querySelector('#home-entries').innerHTML = entries.map(([title, note, icon, tab]) => `<button type="button" class="entry-card" data-go="${tab}"><span class="entry-icon">${icon}</span><strong>${title}</strong><small>${note}</small></button>`).join('');
  const live = sortedMatches().filter(match => match.status === '進行中');
  document.querySelector('#home-live').innerHTML = live.length ? live.map(match => matchSummaryMarkup(match, { showLink: true })).join('') : '<div class="empty-state">目前沒有進行中的比賽。</div>';
}

function renderSchedule() {
  const matches = sortedMatches();
  const finalExists = matches.some(match => match.stage === 'final');
  const schedule = [...matches.filter(match => match.stage === 'roundRobin'), ...(finalExists ? matches.filter(match => match.stage === 'final') : [{ id: 'FINAL', stage: 'final', isPlaceholder: true }])];
  document.querySelector('#schedule-list').innerHTML = schedule.length ? schedule.map(scheduleMatchCard).join('') : '<div class="empty-state">尚無賽程資料。</div>';
}

function renderCourts() {
  const courts = Object.values(data.courts || {}).sort((a, b) => Number(a.id) - Number(b.id));
  const next = sortedMatches().find(match => match.status === '未開始');
  document.querySelector('#court-list').innerHTML = courts.length ? courts.map(court => {
    const current = court.currentMatchId ? data.matches?.[court.currentMatchId] : null;
    return `<article class="court-card"><div class="court-heading"><h3>${escapeHtml(court.name || `場地 ${court.id}`)}</h3><span class="status-pill ${current ? 'is-live' : ''}">${current ? '使用中' : '空場'}</span></div><p class="court-now">目前比賽</p><strong>${current ? escapeHtml(matchTitle(current)) : '目前空場'}</strong><p class="court-next"><strong>下一場未開始：</strong>${next ? `${escapeHtml(matchTitle(next))}（${escapeHtml(stageName(next.stage))}）` : '目前沒有候補比賽'}</p></article>`;
  }).join('') : '<div class="empty-state">尚無場地資料。</div>';
}

function renderLive() {
  const live = sortedMatches().filter(match => match.status === '進行中');
  document.querySelector('#live-list').innerHTML = live.length ? live.map(match => matchSummaryMarkup(match, { showLink: true })).join('') : '<div class="empty-state">目前沒有進行中的比賽。</div>';
}

function renderResults() {
  const ended = sortedMatches().filter(match => match.status === '已結束');
  document.querySelector('#results-list').innerHTML = ended.length ? ended.map(match => {
    const state = stateFor(match);
    return `<article class="result-card"><div class="result-heading"><div><span class="match-stage">${escapeHtml(stageName(match.stage))}・${escapeHtml(match.id)}</span><h3 class="match-title">${escapeHtml(matchTitle(match))}</h3></div><span class="status-pill is-ended">已結束</span></div><div class="series-score"><span>${state.score?.[match.teamAId] ?? 0}</span><span class="score-separator">:</span><span>${state.score?.[match.teamBId] ?? 0}</span></div><p class="section-note">系列賽勝方：${escapeHtml(teamName(state.winnerTeamId))}</p>${gamesMarkup(state)}</article>`;
  }).join('') : '<div class="empty-state">尚無已結束的比賽。</div>';
}

function renderStandings() {
  const table = currentStandings();
  const cycleMatches = allMatches().filter(match => match.stage === 'roundRobin');
  const allFinished = cycleMatches.length === 6 && cycleMatches.every(match => match.status === '已結束');
  const finalistsUnique = table.length >= 2 && table[0].rank === 1 && table[1].rank === 2 && table.filter(row => row.rank <= 2).length === 2;
  const canQualify = allFinished && finalistsUnique;
  document.querySelector('#tie-notice').hidden = !allFinished || finalistsUnique;
  const head = '<table><thead><tr><th>名次</th><th>隊伍</th><th>勝場</th><th>敗場</th><th>已賽</th><th>小局勝</th><th>小局敗</th><th>勝負差</th></tr></thead><tbody>';
  const rows = table.map((row, index) => {
    const qualifies = canQualify && index < 2;
    return `<tr class="${qualifies ? 'is-qualifier' : ''}"><td class="rank-cell">${row.rank}</td><td><strong>${escapeHtml(row.teamName)}</strong>${qualifies ? '<span class="qualify-tag">晉級</span>' : ''}</td><td>${row.matchWins}</td><td>${row.matchLosses}</td><td>${row.matchesPlayed}</td><td>${row.mapsWon}</td><td>${row.mapsLost}</td><td>${row.mapDiff > 0 ? '+' : ''}${row.mapDiff}</td></tr>`;
  }).join('');
  document.querySelector('#standings-table').innerHTML = table.length ? `${head}${rows}</tbody></table>` : '<div class="empty-state">尚無隊伍資料。</div>';
}

function renderSearch() {
  const container = document.querySelector('#search-results');
  const query = searchTerm.trim().toLocaleLowerCase();
  if (!query) {
    container.innerHTML = '<div class="empty-state">輸入隊名或選手名後顯示相關比賽。</div>';
    return;
  }
  const standingsById = Object.fromEntries(currentStandings().map(row => [row.teamId, row]));
  const found = Object.values(data.teams || {}).filter(team => [team.name, ...(team.players || [])].some(name => String(name).toLocaleLowerCase().includes(query)));
  if (!found.length) {
    container.innerHTML = '<div class="empty-state">找不到符合的隊名或選手名。</div>';
    return;
  }
  container.innerHTML = found.map(team => {
    const row = standingsById[team.id];
    const related = sortedMatches().filter(match => match.teamAId === team.id || match.teamBId === team.id);
    return `<article class="search-team-card"><h3>${escapeHtml(team.name)}</h3><p>選手：${(team.players || []).map(escapeHtml).join('、') || '尚未設定'}${row ? `｜目前排名：第 ${row.rank} 名，${row.matchWins} 勝 ${row.matchLosses} 敗，小局差 ${row.mapDiff > 0 ? '+' : ''}${row.mapDiff}` : ''}</p><div>${related.length ? related.map(match => {
      const state = stateFor(match);
      return `<div class="search-match"><strong>${escapeHtml(stageName(match.stage))} ${escapeHtml(match.id)}</strong>｜${escapeHtml(matchTitle(match))}｜${escapeHtml(statusText(match))}${match.status === '未開始' ? '' : `｜${state.score?.[match.teamAId] ?? 0}:${state.score?.[match.teamBId] ?? 0}`}</div>`;
    }).join('') : '<div class="search-match">尚無相關比賽。</div>'}</div></article>`;
  }).join('');
}

function renderSingleMatch() {
  const match = data.matches?.[matchQuery];
  const target = document.querySelector('#single-match-content');
  if (!match) {
    target.innerHTML = `<div class="empty-state">找不到比賽代號 ${escapeHtml(matchQuery)}。<br>請確認網址中的比賽代號。</div>`;
    return;
  }
  target.innerHTML = matchSummaryMarkup(match, { large: true });
}

function renderTabs() {
  for (const panel of document.querySelectorAll('[data-panel]')) {
    const active = panel.dataset.panel === activeTab;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  }
  for (const tab of document.querySelectorAll('[data-tab]')) tab.classList.toggle('active', tab.dataset.tab === activeTab);
}

function render() {
  renderHeader();
  if (singleMatchMode) {
    root.classList.add('single-match');
    renderSingleMatch();
    return;
  }
  renderTabs();
  renderHome();
  renderSchedule();
  renderCourts();
  renderLive();
  renderResults();
  renderStandings();
  const focusedSearch = document.activeElement?.id === 'team-search';
  const selection = focusedSearch ? document.querySelector('#team-search').selectionStart : null;
  renderSearch();
  if (focusedSearch) {
    const input = document.querySelector('#team-search');
    input.focus();
    if (selection != null) input.setSelectionRange(selection, selection);
  }
}

document.querySelector('#main-tabs').addEventListener('click', event => {
  const tab = event.target.closest('[data-tab]');
  if (!tab) return;
  activeTab = tab.dataset.tab;
  renderTabs();
});
document.body.addEventListener('click', event => {
  const button = event.target.closest('[data-go]');
  if (!button) return;
  activeTab = button.dataset.go;
  renderTabs();
  document.querySelector(`#panel-${activeTab}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});
document.querySelector('#team-search').addEventListener('input', event => {
  searchTerm = event.target.value;
  renderSearch();
});

watchConnection(value => { connected = value; render(); }, error => {
  connected = false;
  render();
  console.error('Realtime Database connection listener failed:', error);
});
watchTournament(value => {
  dataError = '';
  data = value || {};
  render();
}, error => {
  dataError = error?.message || '請檢查 Database Rules 與網路連線。';
  render();
});
