// Pure rules for a best-of-three esports match.
// A match is reconstructed from its action log; callers can undo by removing
// the last action and calling replay() again.

export const ACTIONS = Object.freeze({
  START_MATCH: Object.freeze({ type: 'START_MATCH', label: '建立對戰' }),
  START_GAME: Object.freeze({ type: 'START_GAME', label: '開始本局' }),
  RECORD_SCORE: Object.freeze({ type: 'RECORD_SCORE', label: '記錄分數' }),
  END_GAME: Object.freeze({ type: 'END_GAME', label: '判定本局勝方' }),
});

export const SCORE_TYPES = Object.freeze({
  KILLS: 'kills',
  TOWERS: 'towers',
});

export const ACTION_DEFINITIONS = Object.freeze([
  Object.freeze({ ...ACTIONS.START_MATCH, fields: Object.freeze(['teams']) }),
  Object.freeze({ ...ACTIONS.START_GAME, fields: Object.freeze(['blueTeamId?']) }),
  Object.freeze({ ...ACTIONS.RECORD_SCORE, fields: Object.freeze(['teamId', 'scoreType', 'amount?']) }),
  Object.freeze({ ...ACTIONS.END_GAME, fields: Object.freeze(['winnerTeamId']) }),
]);

const MAX_GAMES = 3;
const WINS_NEEDED = 2;

function idOf(value) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return '';
}

function normalizeTeam(value) {
  if (typeof value === 'string' || typeof value === 'number') {
    const id = String(value);
    if (!id.trim()) return null;
    return { id, name: id };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = idOf(value.id);
  if (!id.trim()) return null;
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id;
  return { id, name };
}

function normalizeTeams(values, expectedCount) {
  if (!Array.isArray(values) || (expectedCount != null && values.length !== expectedCount)) return null;
  const teams = values.map(normalizeTeam);
  if (teams.some(team => !team)) return null;
  if (new Set(teams.map(team => team.id)).size !== teams.length) return null;
  return teams;
}

function scoreMap(teams, initial = 0) {
  return Object.fromEntries(teams.map(team => [team.id, initial]));
}

function freshState() {
  return {
    status: 'not_started',
    isComplete: false,
    teams: [],
    score: {}, // series wins by team ID
    games: [],
    currentGame: null,
    nextBlueTeamId: null,
    winnerTeamId: null,
    winner: null,
    winMethod: null,
    winMethodLabel: null,
    rejectedEvents: [],
  };
}

function teamById(state, id) {
  return state.teams.find(team => team.id === id) ?? null;
}

function failure(reason) {
  return { ok: false, reason };
}

/** Return whether action is valid in the supplied reconstructed state. */
export function canApply(state, action) {
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') {
    return failure('動作必須是含有 type 的物件。');
  }

  if (action.type === ACTIONS.START_MATCH.type) {
    if (state.status !== 'not_started') return failure('對戰已建立，不能再次建立。');
    if (!normalizeTeams(action.teams, 2)) return failure('對戰必須包含兩支 ID 不同的隊伍。');
    return { ok: true, reason: null };
  }

  if (state.status === 'not_started') return failure('請先建立對戰。');
  if (state.isComplete) return failure('比賽已結束，不能再執行計分動作。');

  if (action.type === ACTIONS.START_GAME.type) {
    if (state.currentGame) return failure('目前這一局尚未結束。');
    if (state.games.length >= MAX_GAMES) return failure('已達三局上限。');
    const selectedBlueId = action.blueTeamId == null ? state.nextBlueTeamId : idOf(action.blueTeamId);
    if (selectedBlueId == null || selectedBlueId === '') {
      return failure('第一局開始前必須指定藍方隊伍。');
    }
    if (!teamById(state, selectedBlueId)) return failure('藍方必須是本場比賽的其中一隊。');
    return { ok: true, reason: null };
  }

  if (action.type === ACTIONS.RECORD_SCORE.type) {
    if (!state.currentGame) return failure('請先開始一局，才能記錄分數。');
    if (!teamById(state, idOf(action.teamId))) return failure('得分隊伍必須是本場比賽的其中一隊。');
    if (action.scoreType !== SCORE_TYPES.KILLS && action.scoreType !== SCORE_TYPES.TOWERS) {
      return failure('分數種類只能是 kills 或 towers。');
    }
    const amount = action.amount == null ? 1 : action.amount;
    if (!Number.isInteger(amount) || amount <= 0) return failure('分數增量必須是正整數。');
    return { ok: true, reason: null };
  }

  if (action.type === ACTIONS.END_GAME.type) {
    if (!state.currentGame) return failure('目前沒有進行中的一局。');
    if (!teamById(state, idOf(action.winnerTeamId))) return failure('勝方必須是本場比賽的其中一隊。');
    return { ok: true, reason: null };
  }

  return failure(`不認得的計分動作：${action.type}。`);
}

function applyAction(state, action) {
  if (action.type === ACTIONS.START_MATCH.type) {
    state.teams = normalizeTeams(action.teams, 2);
    state.score = scoreMap(state.teams);
    state.status = 'in_progress';
    return;
  }

  if (action.type === ACTIONS.START_GAME.type) {
    const blueTeamId = action.blueTeamId == null ? state.nextBlueTeamId : idOf(action.blueTeamId);
    const redTeamId = state.teams.find(team => team.id !== blueTeamId).id;
    const game = {
      number: state.games.length + 1,
      status: 'in_progress',
      blueTeamId,
      redTeamId,
      score: {
        kills: scoreMap(state.teams),
        towers: scoreMap(state.teams),
      },
      winnerTeamId: null,
      winnerSide: null,
    };
    state.games.push(game);
    state.currentGame = game;
    return;
  }

  if (action.type === ACTIONS.RECORD_SCORE.type) {
    const amount = action.amount == null ? 1 : action.amount;
    const teamId = idOf(action.teamId);
    state.currentGame.score[action.scoreType][teamId] += amount;
    return;
  }

  if (action.type === ACTIONS.END_GAME.type) {
    const game = state.currentGame;
    const winnerTeamId = idOf(action.winnerTeamId);
    game.status = 'ended';
    game.winnerTeamId = winnerTeamId;
    game.winnerSide = winnerTeamId === game.blueTeamId ? 'blue' : 'red';
    state.score[winnerTeamId] += 1;
    state.currentGame = null;
    state.nextBlueTeamId = game.redTeamId;
    if (state.score[winnerTeamId] >= WINS_NEEDED) {
      state.status = 'ended';
      state.isComplete = true;
      state.winnerTeamId = winnerTeamId;
      state.winner = { ...teamById(state, winnerTeamId) };
      state.winMethod = 'first_to_two_games';
      state.winMethodLabel = '三戰兩勝：先贏兩局';
    }
  }
}

/** Rebuild a complete match state by applying valid actions in order. */
export function replay(events) {
  const state = freshState();
  if (!Array.isArray(events)) {
    state.rejectedEvents.push({ index: null, type: null, reason: 'events 必須是陣列。' });
    return state;
  }

  events.forEach((action, index) => {
    const result = canApply(state, action);
    if (!result.ok) {
      state.rejectedEvents.push({
        index,
        type: action && typeof action.type === 'string' ? action.type : null,
        reason: result.reason,
      });
      return;
    }
    applyAction(state, action);
  });

  return state;
}

function getTeamName(state, teamId) {
  return teamById(state, teamId)?.name ?? String(teamId ?? '');
}

/** Return spectator-facing text and structured rows for rendering. */
export function describe(state) {
  const teams = Array.isArray(state?.teams) ? state.teams : [];
  const games = Array.isArray(state?.games) ? state.games : [];
  const score = state?.score ?? {};
  const statusText = state?.isComplete ? '比賽已結束' : teams.length ? '比賽進行中' : '尚未開始';
  const scoreText = teams.length === 2
    ? `${teams[0].name} ${score[teams[0].id] ?? 0} : ${score[teams[1].id] ?? 0} ${teams[1].name}`
    : '尚未建立對戰';
  const progressDots = teams.map(team => {
    const wins = Math.min(WINS_NEEDED, score[team.id] ?? 0);
    const dots = Array.from({ length: WINS_NEEDED }, (_, index) => index < wins ? '●' : '○');
    return { teamId: team.id, teamName: team.name, dots, text: `${team.name} ${dots.join('')}` };
  });

  const gameResults = games.map(game => {
    const blueName = getTeamName(state, game.blueTeamId);
    const redName = getTeamName(state, game.redTeamId);
    const kills = game.score?.kills ?? {};
    const towers = game.score?.towers ?? {};
    const winnerText = game.winnerTeamId
      ? `${game.winnerSide === 'blue' ? '藍方' : '紅方'}（${getTeamName(state, game.winnerTeamId)}）獲勝`
      : '尚未判定勝方';
    const killsText = `${blueName} ${kills[game.blueTeamId] ?? 0} : ${kills[game.redTeamId] ?? 0} ${redName}`;
    const towersText = `${blueName} ${towers[game.blueTeamId] ?? 0} : ${towers[game.redTeamId] ?? 0} ${redName}`;
    return {
      gameNumber: game.number,
      blueTeamId: game.blueTeamId,
      redTeamId: game.redTeamId,
      winnerTeamId: game.winnerTeamId,
      killsText,
      towersText,
      winnerText,
      text: `第 ${game.number} 局｜擊殺：${killsText}｜推塔：${towersText}｜${winnerText}`,
    };
  });

  const progressText = progressDots.map(item => item.text).join('　');
  const resultText = state?.winnerTeamId
    ? `系列賽勝方：${getTeamName(state, state.winnerTeamId)}（${state.winMethodLabel ?? '三戰兩勝'}）`
    : '';
  const lines = [statusText, scoreText, progressText, ...gameResults.map(game => game.text), resultText].filter(Boolean);
  return { statusText, scoreText, progressDots, progressText, gameResults, resultText, text: lines.join('\n') };
}

function requireStandingsTeams(teams) {
  const normalized = normalizeTeams(teams);
  if (!normalized || normalized.length < 2) {
    throw new TypeError('teams 必須是至少兩支 ID 不重複的隊伍。');
  }
  return normalized;
}

/** Rank teams using completed round-robin matches only: match wins, then map differential. */
export function standings(teams, matches) {
  const normalizedTeams = requireStandingsTeams(teams);
  const rows = normalizedTeams.map((team, originalIndex) => ({
    rank: null,
    teamId: team.id,
    teamName: team.name,
    matchesPlayed: 0,
    matchWins: 0,
    matchLosses: 0,
    mapsWon: 0,
    mapsLost: 0,
    mapDiff: 0,
    _originalIndex: originalIndex,
  }));
  const byId = new Map(rows.map(row => [row.teamId, row]));

  for (const match of Array.isArray(matches) ? matches : []) {
    if (!match || match.phase !== 'roundRobin' || !Array.isArray(match.events)) continue;
    const state = replay(match.events);
    if (!state.isComplete || !state.winnerTeamId || state.teams.length !== 2) continue;
    const [left, right] = state.teams;
    const leftRow = byId.get(left.id);
    const rightRow = byId.get(right.id);
    if (!leftRow || !rightRow) continue;

    leftRow.matchesPlayed += 1;
    rightRow.matchesPlayed += 1;
    const leftMaps = state.score[left.id] ?? 0;
    const rightMaps = state.score[right.id] ?? 0;
    leftRow.mapsWon += leftMaps;
    leftRow.mapsLost += rightMaps;
    rightRow.mapsWon += rightMaps;
    rightRow.mapsLost += leftMaps;
    if (state.winnerTeamId === left.id) {
      leftRow.matchWins += 1;
      rightRow.matchLosses += 1;
    } else {
      rightRow.matchWins += 1;
      leftRow.matchLosses += 1;
    }
  }

  for (const row of rows) row.mapDiff = row.mapsWon - row.mapsLost;
  rows.sort((a, b) => b.matchWins - a.matchWins || b.mapDiff - a.mapDiff || a._originalIndex - b._originalIndex);
  let rank = 0;
  rows.forEach((row, index) => {
    const previous = rows[index - 1];
    if (!previous || row.matchWins !== previous.matchWins || row.mapDiff !== previous.mapDiff) rank = index + 1;
    row.rank = rank;
    delete row._originalIndex;
  });
  return rows;
}

/** Generate the six pairings in a four-team single round robin. */
export function roundRobin(teams) {
  const normalizedTeams = normalizeTeams(teams, 4);
  if (!normalizedTeams) throw new TypeError('roundRobin 需要四支 ID 不重複的隊伍。');
  const matches = [];
  for (let left = 0; left < normalizedTeams.length; left += 1) {
    for (let right = left + 1; right < normalizedTeams.length; right += 1) {
      const pair = [normalizedTeams[left], normalizedTeams[right]].map(team => ({ ...team }));
      const number = matches.length + 1;
      matches.push({
        id: `RR-${number}`,
        phase: 'roundRobin',
        teams: pair,
        events: [{ type: ACTIONS.START_MATCH.type, teams: pair.map(team => ({ ...team })) }],
      });
    }
  }
  return matches;
}
