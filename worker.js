// worker.js
// デバッグログ送信用
function sendLog(msg, progress){
  postMessage({ type:'log', msg: msg, progress: progress });
}

// ===== ここで埋め込むテキスト =====
// テスト用に小さめから試してください。
// 実データを入れる場合は文字数に注意。
// 例: 'A'.repeat(30000) などで試す。
let EMBED_TEXT = (function(){
  // デバッグ時は短くする。実運用で差し替え可。
  // 例: return 'これはテスト。'.repeat(5000);
  return 'これはテスト文章です。'.repeat(1500); // 約約30k文字前後の例
})();

sendLog('埋め込みテキスト長: ' + EMBED_TEXT.length);

// ===== チャンク分割パラメータ =====
const CHUNK_SIZE = 8000; // トークナイズ負荷を下げるため小チャンクに（チューニング可）

// ===== トークナイザ（簡易） =====
function tokenize(text){
  // ここは単純に 1文字単位でもOK（python版のような複合トークナイズが必要なら置換）
  // 1文字で扱うとモデルサイズはテキスト長に近くなるが簡潔。
  const res = [];
  for(let i=0;i<text.length;i++) res.push(text[i]);
  return res;
}

// ===== マルコフ表をチャンクごとに構築してマージ =====
function mergeTables(base, add){
  for (const k in add) {
    if (!base[k]) base[k] = {};
    const obj = add[k];
    for (const kk in obj) {
      base[k][kk] = (base[k][kk] || 0) + obj[kk];
    }
  }
  return base;
}

function buildMarkovChunk(tokens){
  const table = {};
  for (let i=0;i<tokens.length-1;i++){
    const a = tokens[i], b = tokens[i+1];
    if (!table[a]) table[a] = {};
    table[a][b] = (table[a][b]||0) + 1;
  }
  return table;
}

// 非同期でチャンク処理（UIブロック回避）
function buildMarkovAsync(text, onProgress){
  return new Promise((resolve, reject) => {
    try {
      const total = text.length;
      let pos = 0;
      let globalTable = {};
      function step(){
        if (pos >= total) {
          onProgress(1);
          resolve(globalTable);
          return;
        }
        const slice = text.slice(pos, pos + CHUNK_SIZE);
        const toks = tokenize(slice);
        const chunkTable = buildMarkovChunk(toks);
        mergeTables(globalTable, chunkTable);
        pos += CHUNK_SIZE;
        onProgress(Math.min(1, pos/total));
        // 次のチャンクは遅らせてUI (メインスレッド) が反応する余裕を作る
        setTimeout(step, 0);
      }
      step();
    } catch (e) {
      reject(e);
    }
  });
}

// ===== 重み付きランダム =====
function weightedRandom(obj){
  const keys = Object.keys(obj);
  let total=0;
  for (const k of keys) total += obj[k];
  let r = Math.random()*total;
  for (const k of keys){
    r -= obj[k];
    if (r <= 0) return k;
  }
  return keys[0];
}

// ===== 生成 =====
function generateFromModel(model, seed, maxLen=200){
  let cur = seed;
  let out = cur;
  for (let i=0;i<maxLen;i++){
    if (!model[cur]) break;
    const nxt = weightedRandom(model[cur]);
    out += nxt;
    cur = nxt;
  }
  return out;
}

// ===== 初期化（build） =====
(async function init(){
  try {
    postMessage({ type:'log', msg:'モデル構築開始' });
    const model = await buildMarkovAsync(EMBED_TEXT, (p) => {
      postMessage({ type:'log', msg:'構築進捗 ' + Math.round(p*100) + '%', progress: p });
    });
    // 保存
    self.MODEL = model;
    postMessage({ type:'ready' });
    postMessage({ type:'log', msg:'モデル構築完了。キー数: ' + Object.keys(model).length });
  } catch (err) {
    postMessage({ type:'error', error: String(err) });
  }
})();

// ===== メッセージ待ち =====
onmessage = function(ev){
  const data = ev.data;
  if (data && data.type === 'generate') {
    try {
      if (!self.MODEL) {
        postMessage({ type:'error', error:'モデル未構築' });
        return;
      }
      const seed = (data.seed && data.seed.length ? data.seed : Object.keys(self.MODEL)[0]);
      const out = generateFromModel(self.MODEL, seed, 200);
      postMessage({ type:'response', text: out });
    } catch (err) {
      postMessage({ type:'error', error: String(err) });
    }
  }
};
