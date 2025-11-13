const { v4: uuidv4 } = require('uuid');

function createNewGame({ chatId, type = 'solo', creator, overs = 1 }) {
  const id = uuidv4();
  const state = {
    id,
    chatId,
    type,
    creator,
    overs,
    inningsTotalBalls: overs * 6,
    status: 'waiting',
    players: [],
    playersStats: {},
    currentInnings: 1,
    innings: {
      1: { battingIndex: 0, bowlingIndex: 1, ballsBowledByCurrentBowler: 0, totalBalls: 0, wickets: 0, score: 0, history: [] },
      2: { battingIndex: 1, bowlingIndex: 0, ballsBowledByCurrentBowler: 0, totalBalls: 0, wickets: 0, score: 0, history: [] }
    },
    waitingForBowlerNumber: false,
    waitingForBatterNumber: false,
    pendingBowlerNumber: null,
    pendingBowlerId: null
  };
  return { id, state };
}

function addPlayer(state, user) {
  if (state.players.find(p => p.id === user.id)) return false;
  state.players.push(user);
  if (!state.playersStats[user.id]) state.playersStats[user.id] = { runs: 0, balls: 0, wickets: 0 };
  return true;
}

function startMatch(state) {
  if (state.players.length < 2) return false;
  state.status = 'in_progress';
  state.currentInnings = 1;
  state.innings[1].battingIndex = 0;
  state.innings[1].bowlingIndex = 1 % state.players.length;
  state.innings[1].ballsBowledByCurrentBowler = 0;
  state.innings[1].totalBalls = 0;
  state.innings[2].battingIndex = 1 % state.players.length;
  state.innings[2].bowlingIndex = 0;
  state.innings[2].ballsBowledByCurrentBowler = 0;
  state.innings[2].totalBalls = 0;
  state.waitingForBowlerNumber = false;
  state.waitingForBatterNumber = false;
  state.pendingBowlerNumber = null;
  state.pendingBowlerId = null;
  return true;
}

function getCurrentInningsState(state) { return state.innings[state.currentInnings]; }
function getCurrentBattingPlayer(state) {
  const innings = getCurrentInningsState(state);
  return state.players[innings.battingIndex];
}
function getCurrentBowlingPlayer(state) {
  const innings = getCurrentInningsState(state);
  return state.players[innings.bowlingIndex];
}

function submitBowlerNumber(state, userId, num) {
  if (state.status !== 'in_progress') return { ok: false, msg: 'Match not in progress' };
  const bowler = getCurrentBowlingPlayer(state);
  if (!bowler || String(bowler.id) !== String(userId)) return { ok: false, msg: 'You are not the current bowler' };
  if (!Number.isInteger(num) || num < 1 || num > 6) return { ok: false, msg: 'Number must be 1-6' };
  state.pendingBowlerNumber = num;
  state.pendingBowlerId = bowler.id;
  state.waitingForBowlerNumber = false;
  state.waitingForBatterNumber = true;
  return { ok: true, action: 'prompt_batter' };
}

function submitBatterNumber(state, userId, num) {
  if (state.status !== 'in_progress') return { ok: false, msg: 'Match not in progress' };
  if (!state.waitingForBatterNumber || state.pendingBowlerNumber == null) return { ok: false, msg: 'No ball is waiting for a batter response' };
  const batter = getCurrentBattingPlayer(state);
  if (!batter || String(batter.id) !== String(userId)) return { ok: false, msg: 'You are not the current batter' };
  if (!Number.isInteger(num) || num < 1 || num > 6) return { ok: false, msg: 'Number must be 1-6' };

  const bowlerNum = state.pendingBowlerNumber;
  const bowlerId = state.pendingBowlerId;
  let outcome = null;
  let runs = 0;
  let wicket = false;

  if (!state.playersStats[batter.id]) state.playersStats[batter.id] = { runs: 0, balls: 0, wickets: 0 };
  if (!state.playersStats[bowlerId]) state.playersStats[bowlerId] = { runs: 0, balls: 0, wickets: 0 };

  state.playersStats[batter.id].balls += 1;

  if (bowlerNum === num) {
    wicket = true;
    outcome = 'W';
    state.innings[state.currentInnings].wickets += 1;
    state.playersStats[bowlerId].wickets += 1;
  } else {
    runs = num;
    outcome = String(num);
    state.innings[state.currentInnings].score += runs;
    state.playersStats[batter.id].runs += runs;
  }

  state.innings[state.currentInnings].history.push({
    bowlerId, bowlerNum, batterId: batter.id, batterNum: num, outcome, timestamp: Date.now()
  });

  state.innings[state.currentInnings].totalBalls += 1;
  state.innings[state.currentInnings].ballsBowledByCurrentBowler += 1;

  state.pendingBowlerNumber = null;
  state.pendingBowlerId = null;
  state.waitingForBatterNumber = false;

  if (state.innings[state.currentInnings].ballsBowledByCurrentBowler >= 3) {
    const inn = state.innings[state.currentInnings];
    const playersCount = state.players.length;
    inn.bowlingIndex = (inn.bowlingIndex + 1) % playersCount;
    inn.ballsBowledByCurrentBowler = 0;
  }

  const inn = state.innings[state.currentInnings];
  if (inn.totalBalls >= state.overs * 6 || inn.wickets >= 10) {
    if (state.currentInnings === 1) {
      state.currentInnings = 2;
      state.status = 'innings_complete';
    } else {
      state.status = 'finished';
    }
  } else {
    state.status = 'in_progress';
    state.waitingForBowlerNumber = true;
  }

  return { ok: true, outcome, runs, wicket, state };
}

function getPlayersScoreList(state) {
  if (!state || !Array.isArray(state.players) || state.players.length === 0) return 'No players yet.';
  const lines = [];
  for (let i = 0; i < state.players.length; i++) {
    const p = state.players[i];
    const stats = state.playersStats[p.id] || { runs: 0, balls: 0, wickets: 0 };
    lines.push(`${i + 1}) ${p.name} — ${stats.runs} runs (${stats.balls} balls), ${stats.wickets} wickets`);
  }
  return lines.join('\n');
}

function computeMOTM(state) {
  if (!state || !Array.isArray(state.players) || state.players.length === 0) return null;
  let best = null;
  for (const p of state.players) {
    const s = state.playersStats[p.id] || { runs: 0, balls: 0, wickets: 0 };
    const candidate = { id: p.id, name: p.name, runs: s.runs, balls: s.balls, wickets: s.wickets };
    if (!best) { best = candidate; continue; }
    if (candidate.runs > best.runs) best = candidate;
    else if (candidate.runs === best.runs) {
      if ((candidate.balls || 0) < (best.balls || 0)) best = candidate;
      else if ((candidate.balls || 0) === (best.balls || 0)) {
        if ((candidate.wickets || 0) > (best.wickets || 0)) best = candidate;
      }
    }
  }
  return best;
}

function getScorecardText(state) {
  const i1 = state.innings[1];
  const i2 = state.innings[2];
  return `Innings 1: ${i1.score}/${i1.wickets} (${i1.totalBalls} balls)\nInnings 2: ${i2.score}/${i2.wickets} (${i2.totalBalls} balls)\nCurrent Innings: ${state.currentInnings}`;
}

module.exports = {
  createNewGame,
  addPlayer,
  startMatch,
  getCurrentBattingPlayer,
  getCurrentBowlingPlayer,
  submitBowlerNumber,
  submitBatterNumber,
  getScorecardText,
  getPlayersScoreList,
  computeMOTM
};