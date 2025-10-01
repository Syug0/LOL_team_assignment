import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import Bottleneck from "bottleneck";
import { LRUCache } from "lru-cache";


dotenv.config();
const app = express();
app.use(express.json());

const API_KEY = process.env.RIOT_API_KEY;
const PLATFORM = process.env.PLATFORM_ROUTING || "jp1";  // summoner/league v4
const REGION = process.env.REGIONAL_ROUTING || "asia";   // match v5
const PORT = process.env.PORT || 3000;

// ---- Rate limit（Riotのレートに優しく）----
const limiter = new Bottleneck({ minTime: 70 }); // ~14 req/sec

// ---- キャッシュ（1時間）----
const cache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 60 });

// ---- ユーティリティ ----
const axiosRiot = axios.create({
  headers: {
    "X-Riot-Token": process.env.RIOT_API_KEY
  }
});

console.log("API KEY:", process.env.RIOT_API_KEY);
if (!API_KEY || API_KEY.includes("あなたのキー")) {
  console.error("ERROR: RIOT_API_KEY is not set in .env");
  process.exit(1);
}

function normalizeRiotId(input) {
  // "GameName#TagLine" または 単純サモナーネーム（古い形式）を許容
  const s = input.trim();
  if (s.includes("#")) {
    const [gameName, tagLine] = s.split("#");
    return { gameName, tagLine };
  }
  return { summonerName: s };
}

function tierToScore(entry) {
  if (!entry) return 1; // 未ランク扱い
  const tier = (entry.tier || "").toUpperCase();
  const div = (entry.rank || "").toUpperCase();
  const base = {
    "IRON": 1, "BRONZE": 2, "SILVER": 3, "GOLD": 4, "PLATINUM": 5,
    "EMERALD": 6, "DIAMOND": 7, "MASTER": 8, "GRANDMASTER": 9, "CHALLENGER": 10
  }[tier] ?? 1;

  // Division微調整（I 〜 IV → 0.6 / 0.4 / 0.2 / 0）
  const divAdj = { "I": 0.6, "II": 0.4, "III": 0.2, "IV": 0.0 }[div] ?? 0;
  return tier === "MASTER" || tier === "GRANDMASTER" || tier === "CHALLENGER" ? base : base + divAdj;
}

function bestRankEntry(entries) {
  // queueType が "RANKED_SOLO_5x5" を優先、なければ他
  if (!entries || !entries.length) return null;
  const solo = entries.find(e => e.queueType === "RANKED_SOLO_5x5");
  return solo || entries[0];
}

// ---- Riot API ラッパー ----

// 1) Riot ID → PUUID (AccountV1)
async function fetchPuuidByRiotId(gameName, tagLine) {
  const key = `puuid:${gameName}#${tagLine}`;
  if (cache.has(key)) return cache.get(key);
  const url = `https://${REGION}.api.riotgames.com/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(gameName)}/${encodeURIComponent(tagLine)}`;
  const { data } = await limiter.schedule(() => axiosRiot.get(url));
  cache.set(key, data);
  return data;
}

// 2) サモナーネーム → SummonerV4
async function fetchSummonerByName(summonerName) {
  const key = `summoner:${PLATFORM}:${summonerName}`;
  if (cache.has(key)) return cache.get(key);
  const url = `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-name/${encodeURIComponent(summonerName)}`;
  const { data } = await limiter.schedule(() => axiosRiot.get(url));
  cache.set(key, data);
  return data;
}

// 3) SummonerId → LeagueV4（ランクエントリー）
async function fetchLeagueBySummonerId(summonerId) {
  const key = `league:${summonerId}`;
  if (cache.has(key)) return cache.get(key);
  const url = `https://${PLATFORM}.api.riotgames.com/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`;
  const { data } = await limiter.schedule(() => axiosRiot.get(url));
  cache.set(key, data);
  return data;
}

// 4) PUUID → 直近試合ID群（ロール推定に利用）
async function fetchRecentMatchIds(puuid, count = 10) {
  const key = `matches:${puuid}:${count}`;
  if (cache.has(key)) return cache.get(key);
  const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?start=0&count=${count}`;
  const { data } = await limiter.schedule(() => axiosRiot.get(url));
  cache.set(key, data);
  return data;
}

// 5) MatchId → 詳細（participants[].teamPosition など）
async function fetchMatch(matchId) {
  const key = `match:${matchId}`;
  if (cache.has(key)) return cache.get(key);
  const url = `https://${REGION}.api.riotgames.com/lol/match/v5/matches/${encodeURIComponent(matchId)}`;
  const { data } = await limiter.schedule(() => axiosRiot.get(url));
  cache.set(key, data);
  return data;
}

// ---- ロール推定（簡易） ----
async function inferPrimaryRole(puuid) {
  try {
    const ids = await fetchRecentMatchIds(puuid, 15);
    const count = { TOP: 0, JUNGLE: 0, MIDDLE: 0, BOTTOM: 0, UTILITY: 0 };
    for (const id of ids) {
      const match = await fetchMatch(id);
      const p = match.info.participants.find(x => x.puuid === puuid);
      const pos = (p?.teamPosition || "").toUpperCase();
      if (count[pos] !== undefined) count[pos]++;
    }
    let best = "UNKNOWN", bestN = -1;
    for (const k of Object.keys(count)) {
      if (count[k] > bestN) { best = k; bestN = count[k]; }
    }
    return best;
  } catch (e) {
    return "UNKNOWN";
  }
}

// ---- エンドポイント ----

// 単一プレイヤー情報（ランク＋スコア＋ロール推定）
app.get("/api/player", async (req, res) => {
  try {
    const q = (req.query.q || "").toString().trim();
    if (!q) return res.status(400).json({ error: "q is required (RiotID 'Name#Tag' or SummonerName)" });

    let summoner, puuid;
    const idObj = normalizeRiotId(q);

    if (idObj.gameName && idObj.tagLine) {
      const acc = await fetchPuuidByRiotId(idObj.gameName, idObj.tagLine);
      puuid = acc.puuid;
      // PUUIDからSummonerを引くAPI（by PUUID）もある
      const url = `https://${PLATFORM}.api.riotgames.com/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`;
      const { data } = await limiter.schedule(() => axiosRiot.get(url));
      summoner = data;
    } else {
      summoner = await fetchSummonerByName(idObj.summonerName);
      puuid = summoner.puuid;
    }

    const leagues = await fetchLeagueBySummonerId(summoner.id);
    const best = bestRankEntry(leagues);
    const score = tierToScore(best);
    const role = await inferPrimaryRole(puuid);

    res.json({
      query: q,
      summoner: { name: summoner.name, summonerId: summoner.id, puuid },
      rankEntry: best, // { tier, rank, leaguePoints, wins, losses, queueType }
      score,
      role
    });
  } catch (e) {
    res.status(e?.response?.status || 500).json({ error: e?.response?.data || e.message });
  }
});

// チーム分け（3パターン）
app.post("/api/team-split", (req, res) => {
  const { players, mode = "balanced" } = req.body || {};
  // players: [{ name, score, role? }, ...]
  if (!Array.isArray(players) || players.length < 2) {
    return res.status(400).json({ error: "players[] >= 2 required" });
  }

  function sumScore(team){ return team.reduce((a,p)=> a + (p.score||1), 0); }

  // パターン1：最小差分（貪欲）
  function splitBalanced(ps) {
    const sorted = [...ps].sort((a,b) => (b.score||1) - (a.score||1));
    const A = [], B = [];
    for (const p of sorted) {
      if (sumScore(A) <= sumScore(B)) A.push(p); else B.push(p);
    }
    return { A, B };
  }

  // パターン2：固定デュオ優先（例：最初の2人を分けない or 同チームなど）
  function splitDuo(ps) {
    if (ps.length >= 2) {
      // 例：最初の2名を同チームに固定して、残りはバランス割り
      const duo = ps.slice(0,2);
      const rest = ps.slice(2).sort((a,b)=> (b.score||1)-(a.score||1));
      const A = [...duo], B = [];
      for (const p of rest) {
        if (sumScore(A) <= sumScore(B)) A.push(p); else B.push(p);
      }
      return { A, B };
    }
    return splitBalanced(ps);
  }

  // パターン3：完全ランダム
  function splitRandom(ps) {
    const shuffled = [...ps].sort(()=> Math.random()-0.5);
    const mid = Math.ceil(shuffled.length/2);
    return { A: shuffled.slice(0,mid), B: shuffled.slice(mid) };
  }

  let result;
  switch (mode) {
    case "balanced": result = splitBalanced(players); break;
    case "duo":      result = splitDuo(players); break;
    case "random":   result = splitRandom(players); break;
    default:         result = splitBalanced(players);
  }

  res.json({
    mode,
    teamA: result.A,
    teamB: result.B,
    scoreA: sumScore(result.A),
    scoreB: sumScore(result.B),
    diff: Math.abs(sumScore(result.A) - sumScore(result.B))
  });
});

app.listen(PORT, () => console.log(`OK: http://localhost:${PORT}`));
