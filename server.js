/**
 * PRED-API v1.1 — TX / Sicbo / Xóc đĩa đa game
 * Render: npm start
 */
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const IDOL = '@htungdzvipmax';

app.use(cors());
app.use(express.json());
app.set('json spaces', 2);

const http = axios.create({
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json, text/plain, */*'
  }
});

/* ═══════════════ GAME CONFIG ═══════════════ */
const GAMES = {
  'sunwin/sicbo': {
    label: 'SUNWIN Sicbo',
    type: 'sicbo',
    url: 'https://api.wsktnus8.net/v2/history/getLastResult?gameId=ktrng_3979&size=100&tableId=39791215743193&curPage=1',
    parser: 'sunwinSicbo'
  },
  'sunhot/tx': {
    label: 'SUNHOT Tài Xỉu',
    type: 'tx',
    url: 'https://su-vipp-3.onrender.com/sun/khnguyen',
    parser: 'sunhot',
    accumulate: true // API chỉ trả 1 phiên → tích lũy local
  },
  'lc79/tx': {
    label: 'LC79 Tài Xỉu',
    type: 'tx',
    url: 'https://wtx.tele68.com/v1/tx/lite-sessions?cp=R&cl=R&pf=web&at=',
    parser: 'lc79List'
  },
  'lc79/md5': {
    label: 'LC79 MD5',
    type: 'tx',
    url: 'https://wtxmd52.tele68.com/v1/txmd5/sessions',
    parser: 'lc79List'
  },
  'lc79/xocdia': {
    label: 'LC79 Xóc Đĩa',
    type: 'xocdia',
    url: 'https://wcl.tele68.com/v1/chanlefull/lite-sessions',
    parser: 'lc79Xocdia'
  },
  'betvip/tx': {
    label: 'BETVIP Tài Xỉu',
    type: 'tx',
    url: 'https://wtx.macminim6.online/v1/tx/sessions',
    parser: 'lc79List'
  },
  'betvip/md5': {
    label: 'BETVIP MD5',
    type: 'tx',
    url: 'https://wtxmd52.macminim6.online/v1/txmd5/sessions',
    parser: 'lc79List'
  },
  'max789/tx': {
    label: 'MAX789 Tài Xỉu',
    type: 'tx',
    url: 'https://taixiu.maksh3979madfw.com/api/luckydice/GetSoiCau',
    parser: 'max789'
  },
  'max789/md5': {
    label: 'MAX789 MD5',
    type: 'tx',
    url: 'https://taixiumd5.maksh3979madfw.com/api/md5luckydice/GetSoiCau',
    parser: 'max789'
  },
  'max789/kubet': {
    label: 'MAX789 Kubet Live',
    type: 'tx',
    url: 'https://txkubet.maksh3979madfw.com/api/taixiukubet/GetSoiCau',
    parser: 'max789'
  },
  'hitclub/tx': {
    label: 'HITCLUB Tài Xỉu',
    type: 'tx',
    url: 'https://apihitclubhihi.onrender.com/api/hitclub/hu',
    parser: 'hitclub'
  },
  'hitclub/md5': {
    label: 'HITCLUB MD5',
    type: 'tx',
    url: 'https://apihitclubhihi.onrender.com/api/hitclub/md5',
    parser: 'hitclub'
  }
};

/* ═══════════════ HELPERS ═══════════════ */
function loadJSON(file, fallback) {
  try {
    const p = path.join(DATA_DIR, file);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {}
  return fallback;
}
function saveJSON(file, data) {
  try {
    fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('saveJSON', file, e.message);
  }
}
function nowVN() {
  return new Date().toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour12: false });
}
function sideFromSum(sum, triple = false) {
  if (triple) return null;
  if (sum >= 11) return 'T';
  if (sum <= 10) return 'X';
  return null;
}
function isTriple(d) {
  return Array.isArray(d) && d.length >= 3 && d[0] === d[1] && d[1] === d[2];
}
function sideLabel(side) {
  if (side === 'T') return 'Tài';
  if (side === 'X') return 'Xỉu';
  if (side === 'CHAN') return 'Chẵn';
  if (side === 'LE') return 'Lẻ';
  return side || null;
}
function parseKetQua(str) {
  const k = String(str || '').toUpperCase();
  if (k.includes('TÀI') || k.includes('TAI') || k === 'T') return 'T';
  if (k.includes('XỈU') || k.includes('XIU') || k === 'X') return 'X';
  if (k.includes('CHẴN') || k.includes('CHAN')) return 'CHAN';
  if (k.includes('LẺ') || k.includes('LE')) return 'LE';
  return null;
}

/* ═══════════════ PARSERS ═══════════════ */
function parseSunwinSicbo(raw) {
  const list = (raw && raw.data && raw.data.resultList) || [];
  return list.map(r => {
    const dice = Array.isArray(r.facesList) ? r.facesList.map(Number) : [];
    const sum = Number(r.score) || dice.reduce((a, b) => a + b, 0);
    const side = sideFromSum(sum, isTriple(dice));
    return {
      session: String(r.gameNum || '').replace('#', ''),
      dice, sum, side,
      time: r.timeMilli ? new Date(r.timeMilli).toISOString() : null
    };
  }).filter(x => x.side && x.dice.length === 3);
}

/** SUNHOT — chỉ lấy phiên + KQ (bỏ du_doan của họ) */
function parseSunhot(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const side = parseKetQua(raw.ket_qua);
  const session = String(raw.phien_truoc || '');
  const next = String(raw.phien_hien_tai || '');
  if (!side || !session) return [];
  return [{
    session,
    side,
    dice: null,
    sum: null,
    nextSession: next,
    time: null
  }];
}

function parseLc79List(raw) {
  const list = (raw && raw.list) || (Array.isArray(raw) ? raw : []);
  return list.map(r => {
    const dice = Array.isArray(r.dices) ? r.dices.map(Number) : [];
    const sum = Number(r.point) || dice.reduce((a, b) => a + b, 0);
    let side = null;
    const rt = String(r.resultTruyenThong || '').toUpperCase();
    if (rt.includes('TAI') || rt === 'T') side = 'T';
    else if (rt.includes('XIU') || rt === 'X') side = 'X';
    else side = sideFromSum(sum, isTriple(dice));
    return {
      session: String(r.id || r._id || ''),
      dice, sum, side, time: null
    };
  }).filter(x => x.side);
}

function parseLc79Xocdia(raw) {
  const list = (raw && raw.list) || [];
  return list.map(r => {
    const faces = Array.isArray(r.dices) ? r.dices.map(String) : [];
    const rt = String(r.resultTruyenThong || '').toLowerCase();
    const side = rt.includes('chan') ? 'CHAN' : rt.includes('le') ? 'LE' : null;
    const vi = String(r.resultVi || '');
    let doCount = 0, trangCount = 0;
    faces.forEach(f => {
      if (f === 'do' || f === 'đỏ' || f === 'red') doCount++;
      else trangCount++;
    });
    return {
      session: String(r.id || r._id || ''),
      dice: faces, side, vi, doCount, trangCount, time: null
    };
  }).filter(x => x.side);
}

function parseMax789(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list.map(r => {
    const d1 = Number(r.FirstDice), d2 = Number(r.SecondDice), d3 = Number(r.ThirdDice);
    const dice = [d1, d2, d3].filter(n => n >= 1 && n <= 6);
    const sum = Number(r.DiceSum) || dice.reduce((a, b) => a + b, 0);
    let side = sideFromSum(sum, isTriple(dice));
    if (r.BetSide === 1 && sum >= 11) side = 'T';
    if (r.BetSide === 0 && sum <= 10) side = 'X';
    return {
      session: String(r.SessionId || ''),
      dice, sum, side,
      time: r.CreatedDate || null
    };
  }).filter(x => x.side && x.dice.length === 3);
}

function parseHitclub(raw) {
  const list = Array.isArray(raw) ? raw
    : (raw && raw.data ? (Array.isArray(raw.data) ? raw.data : [raw.data]) : [raw]);
  return list.map(r => {
    const dice = Array.isArray(r.xuc_xac) ? r.xuc_xac.map(Number)
      : Array.isArray(r.dice) ? r.dice.map(Number)
      : Array.isArray(r.facesList) ? r.facesList.map(Number) : [];
    const sum = Number(r.Tong != null ? r.Tong : r.tong != null ? r.tong : r.sum) || dice.reduce((a, b) => a + b, 0);
    let side = parseKetQua(r.ket_qua || r.Ket_qua || r.result);
    if (!side) side = sideFromSum(sum, isTriple(dice));
    return {
      session: String(r.phien || r.Phien || r.session || r.id || ''),
      dice, sum, side, time: null
    };
  }).filter(x => x.side);
}

const PARSERS = {
  sunwinSicbo: parseSunwinSicbo,
  sunhot: parseSunhot,
  lc79List: parseLc79List,
  lc79Xocdia: parseLc79Xocdia,
  max789: parseMax789,
  hitclub: parseHitclub
};

/* ═══════════════ SOURCE ACCUMULATOR (API 1 phiên) ═══════════════ */
function mergeAccumulate(gameId, rows) {
  const file = `source_${gameId.replace(/\//g, '_')}.json`;
  let store = loadJSON(file, []);
  const map = new Map(store.map(r => [String(r.session), r]));
  for (const r of rows) {
    if (r.session && r.side) map.set(String(r.session), r);
  }
  store = Array.from(map.values()).sort((a, b) => {
    const na = Number(a.session), nb = Number(b.session);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return String(a.session).localeCompare(String(b.session));
  });
  if (store.length > 200) store = store.slice(-200);
  saveJSON(file, store);
  // Trả newest-first cho engine.loadHistory (sẽ reverse)
  return [...store].reverse();
}

/* ═══════════════ PREDICTION ENGINE ═══════════════ */
class Engine {
  constructor(gameId, type) {
    this.id = gameId;
    this.type = type;
    this.history = [];
    this.pending = null;
    this.pendingPhien = null;
    this.correct = 0;
    this.total = 0;
  }

  loadHistory(rows) {
    const sorted = [...rows].reverse();
    this.history = [];
    for (const r of sorted) {
      if (!r.side) continue;
      this.history.push({
        session: r.session,
        side: r.side,
        sum: r.sum,
        dice: r.dice,
        vi: r.vi,
        doCount: r.doCount,
        trangCount: r.trangCount
      });
    }
    if (this.history.length > 300) this.history = this.history.slice(-300);
  }

  /** Cầu hiện tại dạng TXTXT / XXXT... */
  currentCau(maxLen = 20) {
    const h = this.history;
    if (!h.length) return '';
    const chars = h.slice(-maxLen).map(x => {
      if (x.side === 'T') return 'T';
      if (x.side === 'X') return 'X';
      if (x.side === 'CHAN') return 'C';
      if (x.side === 'LE') return 'L';
      return '?';
    });
    return chars.join('');
  }

  accuracy() {
    return this.total ? Math.round((this.correct / this.total) * 100) : 0;
  }

  _txSignals() {
    const h = this.history.filter(x => x.side === 'T' || x.side === 'X');
    const n = h.length;
    if (n < 5) return null;

    const sides = h.map(x => x.side);
    const sums = h.map(x => (x.sum != null ? x.sum : null));
    const last = sides[n - 1];
    const reasons = [];

    const tCount = sides.filter(s => s === 'T').length;
    const pBase = tCount / n;
    const short = sides.slice(-12);
    const pShort = short.filter(s => s === 'T').length / short.length;
    const mid = sides.slice(-36);
    const pMid = mid.filter(s => s === 'T').length / mid.length;
    let ewma = 0.5;
    for (const s of sides.slice(-40)) ewma = 0.88 * ewma + 0.12 * (s === 'T' ? 1 : 0);

    let m1T = 0, m1N = 0;
    for (let i = 0; i < n - 1; i++) {
      if (sides[i] === last) { m1N++; if (sides[i + 1] === 'T') m1T++; }
    }
    const pMarkov1 = m1N >= 4 ? m1T / m1N : 0.5;
    let m2T = 0, m2N = 0;
    if (n >= 3) {
      const a = sides[n - 2], b = sides[n - 1];
      for (let i = 0; i < n - 2; i++) {
        if (sides[i] === a && sides[i + 1] === b) { m2N++; if (sides[i + 2] === 'T') m2T++; }
      }
    }
    const pMarkov2 = m2N >= 3 ? m2T / m2N : 0.5;

    let run = 1;
    for (let i = n - 2; i >= 0; i--) {
      if (sides[i] === last) run++;
      else break;
    }

    // Anti / bẻ cầu
    let pAnti = 0.5, antiW = 0.08;
    if (run >= 5) {
      pAnti = last === 'T' ? 0.34 : 0.66; antiW = 0.22;
      reasons.push(`Cầu bệt ${run} ${last === 'T' ? 'Tài' : 'Xỉu'} → anti bẻ mạnh`);
    } else if (run >= 4) {
      pAnti = last === 'T' ? 0.38 : 0.62; antiW = 0.16;
      reasons.push(`Cầu dài ${run} → anti bẻ`);
    } else if (run >= 3) {
      pAnti = last === 'T' ? 0.42 : 0.58; antiW = 0.11;
      reasons.push('3 cùng phía → anti nhẹ');
    }

    // 1-1 so le
    let pAlt = 0.5, altW = 0.04;
    if (n >= 5) {
      const last5 = sides.slice(-5);
      let alt = true;
      for (let i = 1; i < last5.length; i++) if (last5[i] === last5[i - 1]) { alt = false; break; }
      if (alt) {
        pAlt = last === 'T' ? 0.38 : 0.62; altW = 0.12;
        reasons.push('Cầu 1-1 so le → bắt đảo tiếp');
      }
    }

    // Pattern 2-2
    let pPat = 0.5, patW = 0.05;
    if (n >= 4) {
      const a = sides[n - 4], b = sides[n - 3], c = sides[n - 2], d = sides[n - 1];
      if (a === b && c === d && a !== c) {
        pPat = d === 'T' ? 0.42 : 0.58; patW = 0.12;
        reasons.push(`Cầu 2-2 (${a}${b}${c}${d}) → bẻ nhẹ`);
      }
    }

    // Tổng pattern
    let pSumPat = 0.5, sumPatW = 0.04;
    if (sums[n - 1] != null && sums[n - 2] != null && sums[n - 3] != null) {
      const s1 = sums[n - 1], s2 = sums[n - 2], s3 = sums[n - 3];
      if (s1 === s3 && Math.abs(s1 - s2) >= 3) {
        pSumPat = last === 'T' ? 0.38 : 0.62; sumPatW = 0.14;
        reasons.push(`Tổng trùng 1-1 (${s3}-${s2}-${s1}) → bẻ`);
      }
      if (n >= 4 && sums[n - 4] != null) {
        const rs = [sums[n - 4], sums[n - 3], sums[n - 2], sums[n - 1]];
        const pair1011 =
          (rs[0] === 10 && rs[1] === 11 && rs[2] === 10 && rs[3] === 11) ||
          (rs[0] === 11 && rs[1] === 10 && rs[2] === 11 && rs[3] === 10);
        const pair89 =
          (rs[2] === 8 && rs[3] === 9) || (rs[2] === 9 && rs[3] === 8) ||
          (rs[0] === 8 && rs[1] === 9 && rs[2] === 8 && rs[3] === 9);
        if (pair1011) {
          pSumPat = last === 'T' ? 0.36 : 0.64; sumPatW = 0.16;
          reasons.push('Cầu 10-11 lặp → auto bẻ');
        } else if (pair89) {
          pSumPat = last === 'T' ? 0.38 : 0.62; sumPatW = 0.13;
          reasons.push('Cầu 8-9 → auto bẻ');
        }
      }
      const soLe = sides[n - 1] !== sides[n - 2] && sides[n - 2] !== sides[n - 3] && sides[n - 1] === sides[n - 3];
      const hitSum = [7, 9, 10].includes(s1) || [7, 9, 10].includes(s2) || [7, 9, 10].includes(s3);
      if (soLe && hitSum) {
        pSumPat = last === 'T' ? 0.36 : 0.64; sumPatW = Math.max(sumPatW, 0.15);
        reasons.push('3 so le + 7/9/10 → auto bẻ');
      }
    }

    const pStreak = run === 2 ? (last === 'T' ? 0.54 : 0.46) : 0.5;
    const streakW = run === 2 ? 0.06 : 0.02;

    const weights = {
      base: 0.14, short: 0.10, mid: 0.12, ewma: 0.10,
      markov1: 0.10, markov2: 0.08,
      anti: antiW, alt: altW, pat: patW, sumPat: sumPatW, streak: streakW
    };
    const vals = {
      base: pBase, short: pShort, mid: pMid, ewma,
      markov1: pMarkov1, markov2: pMarkov2,
      anti: pAnti, alt: pAlt, pat: pPat, sumPat: pSumPat, streak: pStreak
    };
    let num = 0, den = 0;
    for (const [k, w] of Object.entries(weights)) { num += vals[k] * w; den += w; }
    let pT = den ? num / den : 0.5;
    pT = Math.max(0.36, Math.min(0.64, pT));

    const side = pT >= 0.5 ? 'T' : 'X';
    const conf = Math.min(66, Math.round(Math.max(pT, 1 - pT) * 100));

    if (!reasons.length) {
      if (Math.abs(pShort - 0.5) > 0.12) {
        reasons.push(pShort > 0.5 ? 'Cửa sổ ngắn nghiêng Tài' : 'Cửa sổ ngắn nghiêng Xỉu');
      } else if (Math.abs(pMarkov1 - 0.5) > 0.08) {
        reasons.push('Markov theo phiên trước');
      } else {
        reasons.push('Ensemble cân bằng · chưa có pattern mạnh');
      }
    }

    return {
      side, conf, pT, run, n,
      lyDo: reasons.slice(0, 3).join(' · '),
      cau: this.currentCau(16)
    };
  }

  _sicboSums(side) {
    const rows = this.history.filter(x => x.sum != null && x.side === side);
    const counts = {};
    for (const r of rows.slice(-120)) counts[r.sum] = (counts[r.sum] || 0) + 1;
    const natural = {
      3: 1, 4: 3, 5: 6, 6: 10, 7: 15, 8: 21, 9: 25, 10: 27,
      11: 27, 12: 25, 13: 21, 14: 15, 15: 10, 16: 6, 17: 3, 18: 1
    };
    const scored = [];
    for (let s = 3; s <= 18; s++) {
      if (side === 'T' && s < 11) continue;
      if (side === 'X' && s > 10) continue;
      if (s === 3 || s === 18) continue;
      scored.push({ sum: s, score: ((counts[s] || 0) + 0.5) * 0.7 + (natural[s] || 1) * 0.3 });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, 3).map(x => x.sum);
  }

  _xocdiaPredict() {
    const h = this.history.filter(x => x.side === 'CHAN' || x.side === 'LE');
    const n = h.length;
    if (n < 5) return null;
    const sides = h.map(x => x.side);
    const chan = sides.filter(s => s === 'CHAN').length;
    const pChan = chan / n;
    const short = sides.slice(-10);
    const pShort = short.filter(s => s === 'CHAN').length / short.length;
    let run = 1;
    const last = sides[n - 1];
    for (let i = n - 2; i >= 0; i--) {
      if (sides[i] === last) run++;
      else break;
    }
    const reasons = [];
    let p = 0.55 * pChan + 0.45 * pShort;
    if (run >= 4) {
      p = last === 'CHAN' ? 0.40 : 0.60;
      reasons.push(`Cầu bệt ${run} ${last === 'CHAN' ? 'Chẵn' : 'Lẻ'} → anti bẻ`);
    } else if (run >= 3) {
      p = last === 'CHAN' ? p * 0.90 : p * 1.10;
      reasons.push('3 cùng phía → anti nhẹ');
    }
    if (n >= 5) {
      const last5 = sides.slice(-5);
      let alt = true;
      for (let i = 1; i < last5.length; i++) if (last5[i] === last5[i - 1]) { alt = false; break; }
      if (alt) {
        p = last === 'CHAN' ? 0.42 : 0.58;
        reasons.push('Cầu 1-1 so le → bắt đảo');
      }
    }
    p = Math.max(0.38, Math.min(0.62, p));
    const side = p >= 0.5 ? 'CHAN' : 'LE';
    const conf = Math.min(62, Math.round(Math.max(p, 1 - p) * 100));
    const viCounts = {};
    for (const r of h.slice(-80)) if (r.vi) viCounts[r.vi] = (viCounts[r.vi] || 0) + 1;
    const candidates = side === 'CHAN'
      ? ['two_trang', 'two_do', 'four_trang', 'four_do']
      : ['three_trang', 'three_do'];
    let topVi = side === 'CHAN' ? 'two_trang' : 'three_do';
    let best = -1;
    for (const c of candidates) {
      const sc = viCounts[c] || 0;
      if (sc > best) { best = sc; topVi = c; }
    }
    const ranked = Object.entries(viCounts)
      .filter(([k]) => side === 'CHAN' ? (k.includes('two') || k.includes('four')) : k.includes('three'))
      .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
    if (!ranked.length) {
      ranked.push(side === 'CHAN' ? 'two_trang' : 'three_do');
      ranked.push(side === 'CHAN' ? 'two_do' : 'three_trang');
    }
    if (!reasons.length) reasons.push('Tần suất Chẵn/Lẻ + cửa sổ ngắn');
    return {
      side, conf, vi: topVi, topVi: ranked.slice(0, 3), n,
      lyDo: reasons.slice(0, 3).join(' · '),
      cau: this.currentCau(16)
    };
  }

  predict() {
    if (this.type === 'xocdia') {
      const pred = this._xocdiaPredict();
      if (!pred) {
        return {
          side: 'CHAN', conf: 50, label: 'Chẵn',
          vi: 'two_trang', topVi: ['two_trang', 'two_do'],
          lyDo: 'Chưa đủ dữ liệu', cau: this.currentCau(16)
        };
      }
      return {
        side: pred.side, conf: pred.conf,
        label: pred.side === 'CHAN' ? 'Chẵn' : 'Lẻ',
        vi: pred.vi, topVi: pred.topVi,
        sampleSize: pred.n, lyDo: pred.lyDo, cau: pred.cau
      };
    }
    const sig = this._txSignals();
    if (!sig) {
      return {
        side: 'T', conf: 50, label: 'Tài',
        topSums: this.type === 'sicbo' ? [11, 12, 13] : [],
        lyDo: 'Chưa đủ dữ liệu · cần thêm lịch sử',
        cau: this.currentCau(16)
      };
    }
    return {
      side: sig.side, conf: sig.conf,
      label: sig.side === 'T' ? 'Tài' : 'Xỉu',
      topSums: this.type === 'sicbo' ? this._sicboSums(sig.side) : [],
      sampleSize: sig.n, streak: sig.run,
      lyDo: sig.lyDo, cau: sig.cau
    };
  }

  settle(actualSide) {
    if (this.pending && actualSide) {
      const ok = this.pending === actualSide;
      this.total++;
      if (ok) this.correct++;
      this.pending = null;
      this.pendingPhien = null;
      return ok;
    }
    return null;
  }

  setPending(side, phien) {
    this.pending = side;
    this.pendingPhien = phien;
  }
}

/* ═══════════════ STATE ═══════════════ */
const engines = {};
const predHistory = loadJSON('pred_history.json', {});
const lastStatus = {}; // gameId -> { ok, error, time }

function getEngine(gameId) {
  if (!engines[gameId]) {
    const g = GAMES[gameId];
    engines[gameId] = new Engine(gameId, g ? g.type : 'tx');
  }
  return engines[gameId];
}

function pushPredLog(gameId, entry) {
  if (!predHistory[gameId]) predHistory[gameId] = [];
  // Chống lặp phiên
  const ph = String(entry.phien);
  const exists = predHistory[gameId].findIndex(e => String(e.phien) === ph);
  if (exists >= 0) {
    // Cập nhật entry cũ nếu chưa settle
    const old = predHistory[gameId][exists];
    if (old.ok == null) predHistory[gameId][exists] = { ...old, ...entry };
  } else {
    predHistory[gameId].unshift(entry);
  }
  if (predHistory[gameId].length > 50) predHistory[gameId] = predHistory[gameId].slice(0, 50);
  saveJSON('pred_history.json', predHistory);
}

function formatHistoryRow(e) {
  const phien = e.phien != null ? String(e.phien).slice(-8) : '—';
  const pred = e.du_doan || '—';
  const actual = e.actual || '…';
  let mark = '⏳';
  if (e.ok === true) mark = '✅';
  else if (e.ok === false) mark = '❌';
  const conf = e.conf != null ? `${e.conf}%` : '';
  return `#${phien}  ${pred} → ${actual}  ${mark}${conf ? '  ' + conf : ''}`;
}

/* ═══════════════ FETCH + PREDICT ═══════════════ */
async function fetchGame(gameId) {
  const g = GAMES[gameId];
  if (!g) throw new Error('Game không tồn tại');
  const res = await http.get(g.url);
  const parser = PARSERS[g.parser];
  if (!parser) throw new Error('Parser thiếu');
  let rows = parser(res.data);
  if (g.accumulate) {
    rows = mergeAccumulate(gameId, rows);
  }
  return { game: g, rows, raw: res.data };
}

async function runPredict(gameId) {
  const { game, rows } = await fetchGame(gameId);
  const eng = getEngine(gameId);
  eng.loadHistory(rows);

  const latest = rows[0] || {};

  // Settle pending theo phiên
  if (rows.length && eng.pending) {
    // Tìm phiên đã có KQ khớp pendingPhien - 1 hoặc latest
    const settledRow = rows.find(r =>
      eng.pendingPhien && String(Number(eng.pendingPhien) - 1) === String(r.session)
    ) || latest;
    if (settledRow && settledRow.side) {
      const ok = eng.settle(settledRow.side);
      const logs = predHistory[gameId] || [];
      // Cập nhật log theo phien đã dự đoán
      for (const log of logs) {
        if (log.ok == null && (String(log.phien) === String(settledRow.session) ||
            (eng.pendingPhien && String(log.phien) === String(eng.pendingPhien)))) {
          // Actually pending was for next session; when that session completes, actual is that session's result
        }
      }
      // Match: prediction was for Phien_tiep; when that becomes latest, settle
      for (const log of logs) {
        if (log.ok != null) continue;
        if (String(log.phien) === String(latest.session) && latest.side) {
          log.actual = sideLabel(latest.side);
          log.ok = (log.du_doan === 'Tài' && latest.side === 'T') ||
                   (log.du_doan === 'Xỉu' && latest.side === 'X') ||
                   (log.du_doan === 'Chẵn' && latest.side === 'CHAN') ||
                   (log.du_doan === 'Lẻ' && latest.side === 'LE') ||
                   (log.du_doan === 'TÀI' && latest.side === 'T') ||
                   (log.du_doan === 'XỈU' && latest.side === 'X');
          log.result_time = nowVN();
          if (log.ok) eng.correct = (eng.correct || 0);
          saveJSON('pred_history.json', predHistory);
          break;
        }
      }
    }
  }

  // Re-settle scan: any open log whose phien appears in source with result
  const logs = predHistory[gameId] || [];
  let dirty = false;
  for (const log of logs) {
    if (log.ok != null) continue;
    const found = rows.find(r => String(r.session) === String(log.phien));
    if (found && found.side) {
      log.actual = sideLabel(found.side);
      const predSide = parseKetQua(log.du_doan);
      log.ok = predSide === found.side;
      log.result_time = nowVN();
      dirty = true;
    }
  }
  if (dirty) saveJSON('pred_history.json', predHistory);

  const pred = eng.predict();
  const nextSession = latest.nextSession
    || (latest.session
      ? (isNaN(Number(latest.session)) ? latest.session : String(Number(latest.session) + 1))
      : '—');

  eng.setPending(pred.side, nextSession);

  const xucXacStr = Array.isArray(latest.dice) && latest.dice.length
    ? latest.dice.join(' - ')
    : null;

  const payload = {
    id: IDOL,
    Name: game.label,
    Phien: latest.session != null
      ? (isNaN(Number(latest.session)) ? latest.session : Number(latest.session))
      : null,
    Xuc_xac: xucXacStr,
    Ket_qua: sideLabel(latest.side),
    Cau_hien_tai: pred.cau || eng.currentCau(16),
    Phien_tiep: isNaN(Number(nextSession)) ? nextSession : Number(nextSession),
    Du_doan: pred.label,
    do_tin_cay: pred.conf,
    Ly_do: pred.lyDo || 'Ensemble cân bằng',
    Time: nowVN()
  };

  if (game.type === 'sicbo') payload.Ba_tong_de_ra = pred.topSums || [];
  if (game.type === 'xocdia') {
    payload.Vi = pred.vi || null;
    payload.Top_vi = pred.topVi || [];
  }

  // Chỉ ghi history nếu phiên mới (chống lặp)
  pushPredLog(gameId, {
    phien: nextSession,
    du_doan: pred.label,
    conf: pred.conf,
    ly_do: pred.lyDo || null,
    cau: pred.cau || null,
    actual: null,
    ok: null,
    time: nowVN()
  });

  lastStatus[gameId] = { ok: true, error: null, time: nowVN() };
  return payload;
}

/* ═══════════════ BACKGROUND POLL (real-time nhẹ) ═══════════════ */
async function backgroundTick() {
  for (const gameId of Object.keys(GAMES)) {
    try {
      await runPredict(gameId);
    } catch (e) {
      lastStatus[gameId] = { ok: false, error: e.message, time: nowVN() };
      console.error('[POLL]', gameId, e.message);
    }
  }
}
// Poll mỗi 25s — giữ data nóng trên Free Render
setInterval(backgroundTick, 25000);
setTimeout(backgroundTick, 5000);

/* ═══════════════ ROUTES ═══════════════ */
app.get('/', (_req, res) => {
  const games = Object.entries(GAMES).map(([id, g]) => {
    const st = lastStatus[id] || { ok: null, error: null, time: null };
    return {
      id: IDOL,
      game: id,
      name: g.label,
      type: g.type,
      status: st.ok === true ? 'online' : st.ok === false ? 'error' : 'pending',
      error: st.error || null,
      last_update: st.time,
      predict: `/${id}`,
      history: `/${id}/history`
    };
  });
  const online = games.filter(g => g.status === 'online').length;
  res.json({
    id: IDOL,
    name: 'PRED-API',
    version: '1.1.0',
    time: nowVN(),
    total_games: games.length,
    online,
    offline: games.length - online,
    games
  });
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, id: IDOL, time: nowVN(), games: Object.keys(GAMES).length });
});

app.get('/games', (_req, res) => {
  const list = Object.entries(GAMES).map(([id, g]) => ({
    id: IDOL,
    game: id,
    label: g.label,
    type: g.type,
    predict: `/${id}`,
    history: `/${id}/history`,
    status: (lastStatus[id] && lastStatus[id].ok) ? 'online' : 'pending'
  }));
  res.json({ id: IDOL, ok: true, total: list.length, games: list });
});

app.get('/:brand/:table/history', (req, res) => {
  const gameId = `${req.params.brand}/${req.params.table}`;
  if (!GAMES[gameId]) return res.status(404).json({ ok: false, error: 'Game không tồn tại' });
  const logs = (predHistory[gameId] || []).slice(0, 50);
  let dung = 0, sai = 0, cho = 0;
  for (const e of logs) {
    if (e.ok === true) dung++;
    else if (e.ok === false) sai++;
    else cho++;
  }
  res.json({
    id: IDOL,
    ok: true,
    game: gameId,
    total: logs.length,
    dung,
    sai,
    cho,
    ti_le: dung + sai > 0 ? Math.round((dung / (dung + sai)) * 100) : 0,
    history: logs.map(formatHistoryRow)
  });
});

app.get('/:brand/:table', async (req, res) => {
  const gameId = `${req.params.brand}/${req.params.table}`;
  if (!GAMES[gameId]) {
    return res.status(404).json({
      ok: false,
      error: 'Game không tồn tại',
      tip: 'Xem GET / hoặc GET /games'
    });
  }
  try {
    const data = await runPredict(gameId);
    res.json(data);
  } catch (e) {
    console.error('[PREDICT]', gameId, e.message);
    lastStatus[gameId] = { ok: false, error: e.message, time: nowVN() };
    res.status(502).json({
      id: IDOL,
      ok: false,
      game: gameId,
      error: 'Không lấy được dữ liệu nguồn',
      detail: e.message,
      Time: nowVN()
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`PRED-API v1.1 on :${PORT}`);
  console.log('Games:', Object.keys(GAMES).join(', '));
});
