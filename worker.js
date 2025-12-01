let learningText = '';
let ngram_n = 2;

// -------------
// 日本語トークナイザ
// -------------
function tokenize(text){
    if(!text) text = "";
    const re = /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|\w+|\s|[^\w\s]/g;
    return text.match(re) || [];
}

// 埋め込みテキスト（学習用）
let EMBED_TEXT = `これはテスト用テキストです。`;

// -------------
// マルコフ連鎖生成
// -------------
function buildMarkov(tokens, n=2) {
  const trans = {};
  for(let i=0; i <= tokens.length - n; i++){
    const key = tokens.slice(i, i+n).join('');
    const next = tokens[i+n];
    if(!trans[key]) trans[key] = [];
    if(next !== undefined) trans[key].push(next);
  }
  return trans;
}

function sampleNext(arr){
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateMarkov(trans, n=2, length=150){
  const keys = Object.keys(trans);
  if(keys.length === 0) return '';
  let key = keys[Math.floor(Math.random() * keys.length)];
  let seq = key.split('');

  for(let i=0; i < length - n; i++){
    const nextArr = trans[key];
    if(!nextArr || nextArr.length === 0) break;
    const next = sampleNext(nextArr);
    seq.push(next);
    key = seq.slice(seq.length - n, seq.length).join('');
  }
  return seq.join('');
}

// -------------
// ターゲット混ぜ込み
// -------------
function injectTargets(tokens, targetTokens, times=5){
  let result = tokens.slice();
  const arr = Array.from(targetTokens);
  for(let t=0; t<times; t++){
    const pos = Math.floor(Math.random() * result.length);
    result = result.slice(0, pos).concat(arr).concat(result.slice(pos));
  }
  return result;
}

// -------------
// GPT 対話モード生成
// -------------
function generateDialogue(markovText, turns = 6) {
    // GPT同士っぽい A/B の交互対話
    let out = "";
    const lines = markovText.split(/(?<=。|\!|\?)\s*/);

    for(let i=0; i<turns; i++){
        let who = (i % 2 === 0) ? "Q" : "A";
        const pick = lines[Math.floor(Math.random() * lines.length)] || markovText;
        out += `${who}: ${pick.trim()}\n`;
    }
    return out;
}

// -------------
// Worker 受信
// -------------
onmessage = function(e) {
  const { type, text, input } = e.data;

  if (type === 'init') {
    learningText = text;
    postMessage({ type:'log', msg:'Worker 初期化完了' });
  }

  else if (type === 'generate') {
    const targetTokens = new Set(tokenize(input));
    let tokens = tokenize(learningText);
    tokens = injectTargets(tokens, targetTokens, 5);

    const trans = buildMarkov(tokens, ngram_n);
    const gen = generateMarkov(trans, ngram_n, 200);

    // GPT風の対話構造に
    const dialogue = generateDialogue(gen, 10);

    postMessage({ type:'result', msg: dialogue });
  }
};
