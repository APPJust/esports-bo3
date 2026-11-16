import {
  applyMatchAction,
  createFinal,
  getFirebaseStatus,
  reopenMatch,
  resetDemoData,
  signIn,
  signOut,
  startMatch,
  undoLastAction,
  watchAuth,
  watchConnection,
  watchTournament,
} from './db.js';
import { ACTIONS, SCORE_TYPES, canApply, describe, replay } from './rules.js';

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const formatTime = value => {
  const date = Number(value);
  return Number.isFinite(date) && date > 0 ? new Date(date).toLocaleString('zh-TW', { hour12: false }) : '尚無資料';
};

let user = null;
let connected = false;
let busy = false;
let data = {};
let selectedMatchId = '';
let blueSelectionByMatch = {};
let stopTournament = () => {};
let loginError = '';
let staffFeedback = '';

function team(id) { return data.teams?.[id] || { id: String(id || ''), name: String(id || '待定'), players: [] }; }
function teamName(id) { return team(id).name || String(id || '待定'); }
function teamPlayers(id) { return team(id).players || []; }
function matches() {
  return Object.values(data.matches || {}).filter(match => match?.id).sort((a, b) => {
    if (a.stage !== b.stage) return a.stage === 'roundRobin' ? -1 : 1;
    return String(a.id).localeCompare(String(b.id), 'en', { numeric: true });
  });
}
function eventRows(matchId) {
  const group = data.events?.[matchId];
  if (!group || typeof group !== 'object') return [];
  return Object.entries(group).filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => ({ key, ...value }))
    .sort((a, b) => (Number(a.sequence) - Number(b.sequence)) || (Number(a.timestamp) - Number(b.timestamp)) || a.key.localeCompare(b.key));
}
function actionsFor(matchId) { return eventRows(matchId).map(event => event.action).filter(action => action?.type); }
function matchState(match) {
  const actions = actionsFor(match.id);
  if (actions.length) return replay(actions);
  return replay([{ type: ACTIONS.START_MATCH.type, teams: [match.teamAId, match.teamBId].map(id => ({ id: String(team(id).id), name: String(teamName(id)) })) }]);
}
function freeCourts(exceptMatchId = '') {
  return Object.values(data.courts || {}).filter(court => !court.currentMatchId || court.currentMatchId === exceptMatchId).sort((a, b) => Number(a.id) - Number(b.id));
}
function matchTitle(match) { return `${teamName(match.teamAId)} VS ${teamName(match.teamBId)}`; }
function updateHeader() {
  const badge = $('#connection-state');
  badge.className = `connection-badge ${connected ? 'is-online' : 'is-offline'}`;
  badge.innerHTML = `<span class="status-dot"></span>${connected ? '已連線' : '離線'}`;
  $('#last-update').textContent = formatTime(data.meta?.lastUpdatedAt);
  $('#offline-notice').hidden = connected;
  const configStatus = getFirebaseStatus();
  $('#config-notice').hidden = configStatus.configured;
  if (!configStatus.configured) $('#config-notice').textContent = `Firebase 尚未設定：${configStatus.message}`;
}
function setLoginError(message = '') {
  loginError = message;
  const target = $('#login-error');
  target.textContent = loginError;
  target.hidden = !loginError;
}
function setFeedback(message = '') {
  staffFeedback = message;
  const target = $('#staff-feedback');
  target.textContent = staffFeedback;
  target.hidden = !staffFeedback;
}
function authErrorInChinese(error) {
  const code = String(error?.code || '');
  const messages = {
    'auth/invalid-email': '電子郵件格式不正確。',
    'auth/invalid-credential': '電子郵件或密碼不正確。',
    'auth/user-not-found': '找不到這個帳號，請確認電子郵件。',
    'auth/wrong-password': '密碼不正確，請再試一次。',
    'auth/too-many-requests': '登入嘗試次數過多，請稍後再試。',
    'auth/network-request-failed': '網路連線失敗，請檢查網路狀態。',
    'auth/operation-not-allowed': 'Firebase 尚未啟用電子郵件／密碼登入。',
    'auth/unauthorized-domain': '目前預覽網址尚未加入 Firebase Authentication 的授權網域。',
    'auth/user-disabled': '這個帳號已停用，請聯絡賽事管理員。',
  };
  if (messages[code]) return messages[code];
  if (error?.message?.includes('config.js')) return error.message;
  return '登入失敗，請確認帳號、密碼和 Firebase Authentication 設定。';
}

function statusClass(status) { return status === '進行中' ? 'is-live' : status === '已結束' ? 'is-ended' : ''; }
function teamPill(id, side) { return `<span class="side-chip ${side === 'red' ? 'red' : ''}">${side === 'blue' ? '藍方' : '紅方'}・${escapeHtml(teamName(id))}</span>`; }
function scorerProgress(state) {
  const view = describe(state);
  return `<div class="series-dots">${view.progressDots.map(item => `<span class="team-progress"><span>${escapeHtml(item.teamName)}</span><span class="dots">${item.dots.join('')}</span></span>`).join('')}</div>`;
}
function scorerGameRows(state) {
  const view = describe(state);
  if (!view.gameResults.length) return '<div class="empty-state">尚未開始第一局。</div>';
  return `<div class="game-list">${view.gameResults.map(game => `<div class="game-row"><strong>第 ${game.gameNumber} 局</strong><div class="metric-line"><span>擊殺</span><span>${escapeHtml(game.killsText)}</span></div><div class="metric-line"><span>推塔</span><span>${escapeHtml(game.towersText)}</span></div><span class="${game.winnerTeamId ? 'game-winner' : 'game-pending'}">${escapeHtml(game.winnerText)}</span></div>`).join('')}</div>`;
}
function scoreButton(matchId, state, teamId, scoreType, side) {
  const action = { type: ACTIONS.RECORD_SCORE.type, teamId, scoreType, amount: 1 };
  const result = canApply(state, action);
  const reason = !connected ? '離線，無法計分。' : result.ok ? '' : result.reason;
  const label = scoreType === SCORE_TYPES.KILLS ? '擊殺 +1' : '推塔 +1';
  return `<button type="button" class="score-add ${side === 'red' ? 'red-side' : ''}" data-action-type="RECORD_SCORE" data-team-id="${escapeHtml(teamId)}" data-score-type="${scoreType}" ${(!connected || busy || !result.ok) ? 'disabled' : ''} title="${escapeHtml(reason)}">${label}<span>${escapeHtml(teamName(teamId))}</span></button>`;
}

function workbenchMarkup(match) {
  const state = matchState(match);
  const teams = state.teams.length === 2 ? state.teams : [team(match.teamAId), team(match.teamBId)];
  const [teamA, teamB] = teams;
  const status = match.status || '未開始';
  const game = state.currentGame;
  const courtOptions = freeCourts(match.status === '已結束' ? match.id : '').map(court => `<option value="${escapeHtml(court.id)}">${escapeHtml(court.name)}</option>`).join('');
  const allCourtsBusy = !courtOptions;
  const heading = `<div class="workbench-title"><div><p class="eyebrow">${escapeHtml(match.stage === 'final' ? 'FINAL' : 'ROUND ROBIN')}・${escapeHtml(match.id)}</p><h2>${escapeHtml(matchTitle(match))}</h2><div class="match-meta"><span>${escapeHtml(match.venue || '場地未指定')}</span><span class="status-pill ${statusClass(status)}">${escapeHtml(status)}</span></div></div></div>`;
  const series = `<div class="workbench-score"><div class="workbench-team"><strong>${escapeHtml(teamA.name)}</strong><small>${(teamPlayers(teamA.id) || []).map(escapeHtml).join('・')}</small><span class="score-num">${state.score?.[teamA.id] ?? 0}</span></div><span class="colon">:</span><div class="workbench-team"><strong>${escapeHtml(teamB.name)}</strong><small>${(teamPlayers(teamB.id) || []).map(escapeHtml).join('・')}</small><span class="score-num">${state.score?.[teamB.id] ?? 0}</span></div></div>${scorerProgress(state)}`;

  if (status === '未開始') {
    return `${heading}<p class="section-note">選擇場地後開始本場比賽。第一局開始前需指定藍方。</p><div class="control-row"><div><label for="start-court">指定場地</label><select class="select-input" id="start-court" ${allCourtsBusy ? 'disabled' : ''}>${courtOptions || '<option value="">兩個場地目前都在使用中</option>'}</select></div><button type="button" class="button button-primary" data-start-match="${escapeHtml(match.id)}" ${(!connected || busy || allCourtsBusy) ? 'disabled' : ''}>開始比賽</button></div>`;
  }

  if (status === '已結束') {
    const winnerName = state.winnerTeamId ? teamName(state.winnerTeamId) : '待定';
    return `${heading}${series}<div class="winner-banner">比賽已結束｜勝方：${escapeHtml(winnerName)}</div>${scorerGameRows(state)}<p class="section-note">重開會撤回最後一次「判定本局勝方」，接著可修正比分或勝方。</p><div class="control-row"><div><label for="reopen-court">重開並指定場地</label><select class="select-input" id="reopen-court" ${allCourtsBusy ? 'disabled' : ''}>${courtOptions || '<option value="">沒有空場地</option>'}</select></div><button type="button" class="button button-primary" data-reopen="${escapeHtml(match.id)}" ${(!connected || busy || allCourtsBusy) ? 'disabled' : ''}>重開比賽</button></div>`;
  }

  let controls = '';
  if (game) {
    const blueId = game.blueTeamId;
    const redId = game.redTeamId;
    const kills = game.score.kills;
    const towers = game.score.towers;
    controls = `<div class="game-state-line"><strong>第 ${game.number} 局進行中</strong><div>${teamPill(blueId, 'blue')} ${teamPill(redId, 'red')}</div></div>
      <div class="current-map-score"><div><span>本局擊殺</span><strong>${kills[blueId] ?? 0} : ${kills[redId] ?? 0}</strong></div><div><span>本局推塔</span><strong>${towers[blueId] ?? 0} : ${towers[redId] ?? 0}</strong></div></div>
      <div class="score-category"><h3>擊殺數</h3><div class="score-actions-grid">${scoreButton(match.id, state, blueId, SCORE_TYPES.KILLS, 'blue')}${scoreButton(match.id, state, redId, SCORE_TYPES.KILLS, 'red')}</div></div>
      <div class="score-category"><h3>推塔數</h3><div class="score-actions-grid">${scoreButton(match.id, state, blueId, SCORE_TYPES.TOWERS, 'blue')}${scoreButton(match.id, state, redId, SCORE_TYPES.TOWERS, 'red')}</div></div>
      <div class="game-winner-actions"><button type="button" class="game-winner-button" data-action-type="END_GAME" data-winner-team-id="${escapeHtml(blueId)}" ${(!connected || busy || !canApply(state, { type: ACTIONS.END_GAME.type, winnerTeamId: blueId }).ok) ? 'disabled' : ''}>藍方勝</button><button type="button" class="game-winner-button red" data-action-type="END_GAME" data-winner-team-id="${escapeHtml(redId)}" ${(!connected || busy || !canApply(state, { type: ACTIONS.END_GAME.type, winnerTeamId: redId }).ok) ? 'disabled' : ''}>紅方勝</button></div>`;
  } else {
    const defaultBlueId = state.nextBlueTeamId || teamA.id;
    const chosenBlueId = blueSelectionByMatch[match.id] || defaultBlueId;
    const blueAction = { type: ACTIONS.START_GAME.type, blueTeamId: chosenBlueId };
    const blueSelect = `<select class="select-input" id="blue-team-select">${state.teams.map(candidate => `<option value="${escapeHtml(candidate.id)}" ${candidate.id === chosenBlueId ? 'selected' : ''}>${escapeHtml(candidate.name)}${candidate.id === state.nextBlueTeamId && state.games.length ? '（上局紅方預設）' : ''}</option>`).join('')}</select>`;
    controls = `<p class="section-note">${state.games.length ? `第 ${state.games.length + 1} 局即將開始；藍方預設為上一局紅方。` : '開始第一局前，請選擇藍方。'}</p><div class="control-row"><div><label for="blue-team-select">本局藍方</label>${blueSelect}</div><button type="button" class="button button-primary" data-start-game="${escapeHtml(match.id)}" ${(!connected || busy || !canApply(state, blueAction).ok) ? 'disabled' : ''}>開始第 ${state.games.length + 1} 局</button></div>`;
  }
  const records = eventRows(match.id);
  const canUndo = records.length > 1;
  const undoReason = !connected ? '離線，無法復原。' : canUndo ? '' : '目前沒有可復原的計分動作。';
  return `${heading}${series}${controls}<div class="bench-footer-actions"><button type="button" class="button button-quiet" data-undo="${escapeHtml(match.id)}" ${(!connected || busy || !canUndo) ? 'disabled' : ''} title="${escapeHtml(undoReason)}">復原上一步</button></div>${scorerGameRows(state)}`;
}

function actionDescription(action, match) {
  if (action.type === ACTIONS.START_MATCH.type) return '建立本場對戰';
  if (action.type === ACTIONS.START_GAME.type) return `開始第 ${action.blueTeamId ? '' : '下一'}局，藍方：${teamName(action.blueTeamId)}`;
  if (action.type === ACTIONS.RECORD_SCORE.type) return `${teamName(action.teamId)}　${action.scoreType === SCORE_TYPES.KILLS ? '擊殺' : '推塔'} +${action.amount ?? 1}`;
  if (action.type === ACTIONS.END_GAME.type) return `${teamName(action.winnerTeamId)} 判定獲得本局勝利`;
  return String(action.type || '未知動作');
}

function renderActionLog(match) {
  const records = eventRows(match.id);
  $('#action-log-card').hidden = records.length === 0;
  $('#action-log').innerHTML = records.slice().reverse().map(event => `<li>${escapeHtml(actionDescription(event.action || {}, match))}<time>${formatTime(event.timestamp)}</time></li>`).join('');
}

function renderMatchList() {
  const list = matches();
  if (!selectedMatchId || !data.matches?.[selectedMatchId]) {
    selectedMatchId = list.find(match => match.status === '進行中')?.id || list.find(match => match.status === '未開始')?.id || list[0]?.id || '';
  }
  $('#staff-match-list').innerHTML = list.length ? list.map(match => `<button type="button" class="staff-match-item ${match.id === selectedMatchId ? 'selected' : ''}" data-select-match="${escapeHtml(match.id)}"><span class="staff-match-label"><strong>${escapeHtml(matchTitle(match))}</strong><small>${escapeHtml(match.stage === 'final' ? '決賽' : '循環賽')}・${escapeHtml(match.id)}</small></span><span class="status-pill ${statusClass(match.status)}">${escapeHtml(match.status || '未開始')}</span></button>`).join('') : '<div class="empty-state">沒有比賽資料。請按「重設示範資料」。</div>';
}

function renderFinalButton() {
  const cycles = matches().filter(match => match.stage === 'roundRobin');
  const finalExists = Boolean(data.matches?.FINAL);
  const allFinished = cycles.length === 6 && cycles.every(match => match.status === '已結束');
  const button = $('#create-final-button');
  button.hidden = !allFinished || finalExists;
  button.disabled = !connected || busy;
}

function renderStaff() {
  updateHeader();
  $('#login-view').hidden = Boolean(user);
  $('#staff-view').hidden = !user;
  if (!user) return;
  $('#signed-in-email').textContent = user.email || '已登入';
  renderMatchList();
  renderFinalButton();
  const selected = data.matches?.[selectedMatchId];
  $('#score-workbench').innerHTML = selected ? workbenchMarkup(selected) : '<div class="empty-state">選擇一場比賽開始計分。</div>';
  if (selected) renderActionLog(selected); else $('#action-log-card').hidden = true;
}

async function perform(label, task) {
  if (busy) return;
  busy = true;
  setFeedback('正在寫入 Firebase…');
  renderStaff();
  try {
    await task();
    setFeedback(`${label}完成。`);
  } catch (error) {
    setFeedback(error?.message || `${label}失敗，請確認連線與資料庫規則。`);
  } finally {
    busy = false;
    renderStaff();
  }
}

$('#login-form').addEventListener('submit', async event => {
  event.preventDefault();
  setLoginError('');
  const email = $('#email').value;
  const passwordField = $('#password');
  try {
    await signIn(email, passwordField.value);
    passwordField.value = '';
  } catch (error) {
    setLoginError(authErrorInChinese(error));
  }
});
$('#signout-button').addEventListener('click', async () => {
  try { await signOut(); setFeedback('已登出。'); } catch (error) { setFeedback(error?.message || '登出失敗。'); }
});
$('#reset-demo-button').addEventListener('click', () => {
  $('#reset-confirm').hidden = false;
  $('#confirm-reset').disabled = !connected || busy;
});
$('#cancel-reset').addEventListener('click', () => { $('#reset-confirm').hidden = true; });
$('#confirm-reset').addEventListener('click', async () => {
  $('#reset-confirm').hidden = true;
  await perform('示範資料重設', resetDemoData);
  selectedMatchId = '';
});
$('#create-final-button').addEventListener('click', () => perform('決賽建立', createFinal));

$('#staff-match-list').addEventListener('click', event => {
  const button = event.target.closest('[data-select-match]');
  if (!button) return;
  selectedMatchId = button.dataset.selectMatch;
  renderStaff();
});
$('#score-workbench').addEventListener('change', event => {
  if (event.target.id === 'blue-team-select' && selectedMatchId) blueSelectionByMatch[selectedMatchId] = event.target.value;
});
$('#score-workbench').addEventListener('click', event => {
  const actionButton = event.target.closest('[data-action-type]');
  if (actionButton) {
    const type = actionButton.dataset.actionType;
    let action;
    if (type === ACTIONS.RECORD_SCORE.type) action = { type, teamId: actionButton.dataset.teamId, scoreType: actionButton.dataset.scoreType, amount: 1 };
    if (type === ACTIONS.END_GAME.type) action = { type, winnerTeamId: actionButton.dataset.winnerTeamId };
    if (action) perform('計分動作', () => applyMatchAction(selectedMatchId, action));
    return;
  }
  const start = event.target.closest('[data-start-match]');
  if (start) {
    const courtId = $('#start-court')?.value;
    perform('比賽開始', () => startMatch(start.dataset.startMatch, courtId));
    return;
  }
  const startGameButton = event.target.closest('[data-start-game]');
  if (startGameButton) {
    const blueTeamId = $('#blue-team-select')?.value;
    perform('新局開始', () => applyMatchAction(startGameButton.dataset.startGame, { type: ACTIONS.START_GAME.type, blueTeamId }));
    return;
  }
  const undo = event.target.closest('[data-undo]');
  if (undo) {
    perform('復原', () => undoLastAction(undo.dataset.undo));
    return;
  }
  const reopen = event.target.closest('[data-reopen]');
  if (reopen) {
    const courtId = $('#reopen-court')?.value;
    perform('比賽重開', () => reopenMatch(reopen.dataset.reopen, courtId));
  }
});

watchConnection(value => {
  connected = value;
  renderStaff();
}, error => {
  connected = false;
  setFeedback(error?.message || '無法取得 Firebase 連線狀態。');
  renderStaff();
});

watchAuth(currentUser => {
  user = currentUser;
  if (user) {
    stopTournament();
    stopTournament = watchTournament(value => {
      data = value || {};
      renderStaff();
    }, error => setFeedback(error?.message || '無法讀取 Firebase 資料。'));
  } else {
    stopTournament();
    stopTournament = () => {};
    data = {};
    selectedMatchId = '';
    setFeedback('');
  }
  renderStaff();
}, error => setLoginError(authErrorInChinese(error)));

renderStaff();
