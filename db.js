import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-app.js';
import {
  getDatabase,
  ref,
  child,
  push,
  onValue,
  runTransaction,
  serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-database.js';
import {
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
} from 'https://www.gstatic.com/firebasejs/13.3.0/firebase-auth.js';
import { firebaseConfig } from './config.js';
import { ACTIONS, canApply, replay, roundRobin, standings } from './rules.js';

const REQUIRED_CONFIG = ['apiKey', 'authDomain', 'databaseURL', 'projectId', 'appId'];
const hasConfiguration = REQUIRED_CONFIG.every(key => typeof firebaseConfig[key] === 'string' && firebaseConfig[key].trim());
let app = null;
let database = null;
let auth = null;
let initializationError = '';
let connected = false;

if (hasConfiguration) {
  try {
    app = initializeApp(firebaseConfig);
    database = getDatabase(app);
    auth = getAuth(app);
  } catch (error) {
    initializationError = error?.message || 'Firebase 初始化失敗。';
  }
}

const EMPTY_CONFIG_MESSAGE = '請先在 config.js 貼上 Firebase Web App 設定，並填入 Realtime Database 的 databaseURL。';

export function getFirebaseStatus() {
  return {
    configured: Boolean(database && auth),
    online: connected,
    message: database && auth ? '' : (initializationError || EMPTY_CONFIG_MESSAGE),
  };
}

function requireDatabase() {
  if (!database) throw new Error(initializationError || EMPTY_CONFIG_MESSAGE);
  return database;
}

function requireSignedIn() {
  requireDatabase();
  if (!auth?.currentUser) throw new Error('請先登入計分員帳號。');
  if (!connected) throw new Error('目前離線，連線恢復後才能寫入。');
  return auth.currentUser;
}

export function watchTournament(callback, onError = () => {}) {
  if (!database) {
    callback(null);
    return () => {};
  }
  return onValue(ref(database), snapshot => callback(snapshot.val() || {}), onError);
}

export function watchConnection(callback, onError = () => {}) {
  if (!database) {
    connected = false;
    callback(false);
    return () => {};
  }
  return onValue(ref(database, '.info/connected'), snapshot => {
    connected = snapshot.val() === true;
    callback(connected);
  }, onError);
}

export function watchAuth(callback, onError = () => {}) {
  if (!auth) {
    callback(null);
    return () => {};
  }
  return onAuthStateChanged(auth, callback, onError);
}

export async function signIn(email, password) {
  requireDatabase();
  if (!auth) throw new Error(initializationError || EMPTY_CONFIG_MESSAGE);
  return signInWithEmailAndPassword(auth, String(email).trim(), password);
}

export async function signOut() {
  if (!auth) return;
  return firebaseSignOut(auth);
}

const DEMO_TEAMS = [
  { id: 'T01', name: '彗星旅團', players: ['霓虹', '雲豹', '紙飛機', '月塵'] },
  { id: 'T02', name: '像素花園', players: ['小行星', '泡泡糖', '霧鴉', '星砂'] },
  { id: 'T03', name: '量子水獺', players: ['藍莓塔', '極光', '夜航船', '栗子雲'] },
  { id: 'T04', name: '雨林電波', players: ['薄荷糖', '銀河貓', '晴空', '棉花糖'] },
];

function emptyDemoMatches(teams) {
  const schedule = roundRobin(teams);
  const matches = {};
  for (const scheduled of schedule) {
    const [teamA, teamB] = scheduled.teams;
    matches[scheduled.id] = {
      id: scheduled.id,
      stage: 'roundRobin',
      teamAId: teamA.id,
      teamBId: teamB.id,
      venue: '未指定',
      status: '未開始',
      state: { seriesScore: { [teamA.id]: 0, [teamB.id]: 0 }, gamesPlayed: 0 },
    };
  }
  return matches;
}

function eventRecords(root, matchId) {
  const group = root?.events?.[matchId];
  if (!group || typeof group !== 'object') return [];
  return Object.entries(group)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => ({ key, ...value }))
    .sort((left, right) => (Number(left.sequence) - Number(right.sequence)) || (Number(left.timestamp) - Number(right.timestamp)) || left.key.localeCompare(right.key));
}

function actionsFor(root, matchId) {
  return eventRecords(root, matchId).map(record => record.action).filter(action => action && typeof action.type === 'string');
}

function safeGame(game) {
  const copy = {
    number: game.number,
    status: game.status,
    blueTeamId: game.blueTeamId,
    redTeamId: game.redTeamId,
    score: { kills: { ...game.score.kills }, towers: { ...game.score.towers } },
  };
  if (game.winnerTeamId) copy.winnerTeamId = game.winnerTeamId;
  if (game.winnerSide) copy.winnerSide = game.winnerSide;
  return copy;
}

function stateSummary(state) {
  const summary = {
    seriesScore: { ...state.score },
    gamesPlayed: state.games.length,
    games: state.games.map(safeGame),
  };
  if (state.currentGame) summary.currentGameNumber = state.currentGame.number;
  if (state.nextBlueTeamId) summary.nextBlueTeamId = state.nextBlueTeamId;
  if (state.winnerTeamId) {
    summary.winnerTeamId = state.winnerTeamId;
    summary.winMethod = state.winMethod;
  }
  return summary;
}

function touchMeta(root) {
  root.meta = root.meta || {};
  root.meta.lastUpdatedAt = serverTimestamp();
}

function fail(reason) {
  return { error: reason };
}

async function transactTournament(mutator) {
  const db = requireDatabase();
  requireSignedIn();
  let refusal = '';
  const result = await runTransaction(ref(db), current => {
    const root = current && typeof current === 'object' ? current : {};
    const outcome = mutator(root);
    if (outcome?.error) {
      refusal = outcome.error;
      return undefined;
    }
    touchMeta(root);
    return root;
  }, { applyLocally: false });
  if (!result.committed) throw new Error(refusal || '資料剛有變動，請重新整理後再試。');
  return result.snapshot.val() || {};
}

function assertDemoExists(root) {
  if (!root?.matches || !root?.teams || !root?.courts) return '請先重設示範資料。';
}

function freeCourt(root, courtId, exceptMatchId = '') {
  const court = root?.courts?.[String(courtId)];
  if (!court) return { error: '請選擇場地 1 或場地 2。' };
  if (court.currentMatchId && court.currentMatchId !== exceptMatchId) return { error: `${court.name || `場地 ${courtId}`} 已有進行中的比賽。` };
  return { court };
}

function matchTeams(root, match) {
  const teamA = root?.teams?.[match.teamAId];
  const teamB = root?.teams?.[match.teamBId];
  if (!teamA || !teamB) return null;
  return [
    { id: String(teamA.id), name: String(teamA.name) },
    { id: String(teamB.id), name: String(teamB.name) },
  ];
}

function nextSequence(records) {
  return records.reduce((maximum, record) => Math.max(maximum, Number(record.sequence) || 0), 0) + 1;
}

function appendEvent(root, matchId, eventKey, action, records) {
  root.events = root.events || {};
  root.events[matchId] = root.events[matchId] || {};
  root.events[matchId][eventKey] = {
    sequence: nextSequence(records),
    timestamp: serverTimestamp(),
    action,
  };
}

function releaseCourt(root, match) {
  for (const court of Object.values(root.courts || {})) {
    if (court?.currentMatchId === match.id) delete court.currentMatchId;
  }
}

function eventKeyFor(matchId) {
  return push(child(ref(requireDatabase()), `events/${matchId}`)).key;
}

/** Atomically restore the demo metadata, six matches, empty event log, and two courts. */
export async function resetDemoData() {
  const eventName = '第 22 題〈電競三戰兩勝賽〉';
  const teams = Object.fromEntries(DEMO_TEAMS.map(team => [team.id, { ...team, players: [...team.players] }]));
  const matches = emptyDemoMatches(DEMO_TEAMS.map(({ id, name }) => ({ id, name })));
  return transactTournament(root => {
    root.meta = { eventName, version: 'v2', lastUpdatedAt: Date.now() };
    root.teams = teams;
    root.matches = matches;
    delete root.events;
    root.courts = { '1': { id: '1', name: '場地 1' }, '2': { id: '2', name: '場地 2' } };
  });
}

/** Begin a scheduled match and reserve a court in one root transaction. */
export async function startMatch(matchId, courtId) {
  const key = eventKeyFor(matchId);
  return transactTournament(root => {
    const readyError = assertDemoExists(root);
    if (readyError) return fail(readyError);
    const match = root.matches?.[matchId];
    if (!match) return fail('找不到這場比賽。');
    if (match.status !== '未開始') return fail('只有未開始的比賽可以開打。');
    const selected = freeCourt(root, courtId);
    if (selected.error) return fail(selected.error);
    const teams = matchTeams(root, match);
    if (!teams) return fail('比賽隊伍資料不完整。');
    const action = { type: ACTIONS.START_MATCH.type, teams };
    const events = eventRecords(root, matchId);
    const state = replay([...events.map(record => record.action), action]);
    if (state.rejectedEvents.length) return fail(state.rejectedEvents[0].reason);

    appendEvent(root, matchId, key, action, events);
    match.status = '進行中';
    match.courtId = String(courtId);
    match.venue = selected.court.name || `場地 ${courtId}`;
    match.state = stateSummary(state);
    selected.court.currentMatchId = matchId;
  });
}

/** Apply a match action with event, derived summary, status, and court release atomically. */
export async function applyMatchAction(matchId, action) {
  const key = eventKeyFor(matchId);
  return transactTournament(root => {
    const match = root.matches?.[matchId];
    if (!match) return fail('找不到這場比賽。');
    if (match.status !== '進行中') return fail('比賽目前不在進行中。');
    const events = eventRecords(root, matchId);
    const currentState = replay(events.map(record => record.action));
    if (currentState.rejectedEvents.length) return fail('事件紀錄含有不合法的動作，請先檢查資料。');
    const allowed = canApply(currentState, action);
    if (!allowed.ok) return fail(allowed.reason);
    const storedAction = { ...action };
    if (storedAction.type === ACTIONS.RECORD_SCORE.type && storedAction.amount == null) storedAction.amount = 1;
    const nextState = replay([...events.map(record => record.action), storedAction]);
    if (nextState.rejectedEvents.length) return fail(nextState.rejectedEvents[0].reason);

    appendEvent(root, matchId, key, storedAction, events);
    match.state = stateSummary(nextState);
    if (nextState.isComplete) {
      match.status = '已結束';
      releaseCourt(root, match);
    }
  });
}

/** Remove the newest event, rebuild the state, and update the summary atomically. */
export async function undoLastAction(matchId) {
  return transactTournament(root => {
    const match = root.matches?.[matchId];
    if (!match) return fail('找不到這場比賽。');
    if (match.status !== '進行中') return fail('請先重開已結束的比賽，再復原事件。');
    const records = eventRecords(root, matchId);
    if (records.length <= 1) return fail('目前沒有可復原的計分動作。');
    const last = records[records.length - 1];
    if (!root.events?.[matchId]?.[last.key]) return fail('找不到最後一筆事件。');
    delete root.events[matchId][last.key];
    if (!Object.keys(root.events[matchId]).length) delete root.events[matchId];
    const remaining = records.slice(0, -1).map(record => record.action);
    const state = replay(remaining);
    if (state.rejectedEvents.length) return fail('復原後事件紀錄不合法，沒有寫入變更。');
    match.state = stateSummary(state);
    match.status = '進行中';
  });
}

/** Reopen by removing the final winner declaration and reserving an available court. */
export async function reopenMatch(matchId, courtId) {
  return transactTournament(root => {
    const match = root.matches?.[matchId];
    if (!match) return fail('找不到這場比賽。');
    if (match.status !== '已結束') return fail('只有已結束的比賽可以重開。');
    const selected = freeCourt(root, courtId, matchId);
    if (selected.error) return fail(selected.error);
    const records = eventRecords(root, matchId);
    const last = records[records.length - 1];
    if (!last || last.action?.type !== ACTIONS.END_GAME.type) return fail('找不到最後一局的勝方判定，無法重開。');
    delete root.events[matchId][last.key];
    if (!Object.keys(root.events[matchId]).length) delete root.events[matchId];
    const state = replay(records.slice(0, -1).map(record => record.action));
    if (state.rejectedEvents.length || state.isComplete) return fail('重開後事件狀態不合法，沒有寫入變更。');
    match.status = '進行中';
    match.courtId = String(courtId);
    match.venue = selected.court.name || `場地 ${courtId}`;
    match.state = stateSummary(state);
    selected.court.currentMatchId = matchId;
  });
}

/** Build the final from the two uniquely ranked leaders after all six round-robin matches finish. */
export async function createFinal() {
  return transactTournament(root => {
    const matches = root.matches || {};
    if (matches.FINAL) return fail('決賽已經建立。');
    const roundMatches = Object.values(matches).filter(match => match?.stage === 'roundRobin');
    if (roundMatches.length !== 6) return fail('循環賽資料必須有六場。');
    if (!roundMatches.every(match => match.status === '已結束')) return fail('六場循環賽都結束後才能產生決賽。');
    const teams = Object.values(root.teams || {}).map(team => ({ id: String(team.id), name: String(team.name) }));
    const rankingMatches = roundMatches.map(match => ({
      phase: 'roundRobin',
      events: actionsFor(root, match.id),
    }));
    const table = standings(teams, rankingMatches);
    const topTwo = table.filter(row => row.rank <= 2);
    if (topTwo.length !== 2 || table.length < 2 || table[0].rank !== 1 || table[1].rank !== 2) {
      return fail('第 1、2 名有並列情形，請先決定加賽或其他決勝規則，再產生決賽。');
    }
    const first = root.teams[table[0].teamId];
    const second = root.teams[table[1].teamId];
    root.matches.FINAL = {
      id: 'FINAL',
      stage: 'final',
      teamAId: first.id,
      teamBId: second.id,
      venue: '未指定',
      status: '未開始',
      state: { seriesScore: { [first.id]: 0, [second.id]: 0 }, gamesPlayed: 0 },
    };
  });
}
