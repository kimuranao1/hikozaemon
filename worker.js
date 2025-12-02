// ================================
// 300万文字対応 Web Worker（ターゲットトークン埋め込み + 緩い Markov + ストリーミング）
// ユーザ入力をトークン化してすべてターゲットトークンにし、周辺特徴を組み込んだMarkovを作る
// ================================

let learningChunks = [];  // 分割テキスト
let ngram_n = 2;

// -------------------------
// 汎用トークナイザ（空白・改行・記号を保持）
function tokenize_chunk(chunk, maxTokenLen = 10) {
    const pattern = /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|\w+|\s|[^\w\s]/g;
    const tokens = [];
    let match;
    while ((match = pattern.exec(chunk)) !== null) {
        let tok = match[0];
        if (tok.length > maxTokenLen && !/^\s$/.test(tok) && !/[^\w\s]/.test(tok)) {
            for (let i = 0; i < tok.length; i += maxTokenLen) {
                tokens.push(tok.slice(i, i + maxTokenLen));
            }
        } else {
            tokens.push(tok);
        }
    }
    return tokens;
}

// -------------------------
// 入力ワード専用トークナイザ（連続文字列は最大3文字に分割してターゲットを作る）
function tokenize_input_as_targets(text) {
    // maxTokenLen = 3 for user input splitting contiguous sequences
    return tokenize_chunk(text, 3).filter(t => t !== "");
}

// -------------------------
// 周辺トークン統計（Python版 build_context_counts_multi を意識）
function build_context_counts_multi(tokens, targetSet, N) {
    const counts = new Map(); // key: rel + '\u0000' + token -> count
    const totals = new Map(); // key: rel -> total
    for (let idx = 0; idx < tokens.length; idx++) {
        const tok = tokens[idx];
        if (!targetSet.has(tok)) continue;
        for (let rel = -N; rel <= N; rel++) {
            if (rel === 0) continue;
            const pos = idx + rel;
            if (pos < 0 || pos >= tokens.length) continue;
            const key = rel + '\u0000' + tokens[pos];
            counts.set(key, (counts.get(key) || 0) + 1);
            totals.set(rel, (totals.get(rel) || 0) + 1);
        }
    }
    return {counts, totals};
}

// -------------------------
// スコア計算
function compute_scores(counts, totals, power = 1.0) {
    const scores = new Map(); // key: rel\u0000token -> score
    for (const [k, cnt] of counts.entries()) {
        const rel = parseInt(k.split('\u0000')[0], 10);
        const tot = totals.get(rel) || 0;
        if (tot === 0) continue;
        const prob = cnt / tot;
        scores.set(k, Math.pow(prob, power));
    }
    return scores;
}

// -------------------------
// 特徴選択
function select_features(scores, threshold) {
    const arr = [];
    for (const [k, sc] of scores.entries()) {
        if (sc >= threshold) {
            const parts = k.split('\u0000');
            arr.push({rel: parseInt(parts[0], 10), token: parts[1], score: sc});
        }
    }
    // sort: rel asc, score desc, token asc
    arr.sort((a, b) => (a.rel - b.rel) || (b.score - a.score) || a.token.localeCompare(b.token));
    return arr;
}

// -------------------------
// 埋め込み（ターゲットトークンをオブジェクト化）
// perOccurrence=false の簡易実装（全ターゲットに同一 feature set を付与）
function embed_features_in_corpus(tokens, targetSet, features) {
    const featTuple = features.map(f => ({rel: f.rel, token: f.token, score: f.score}));
    const out = [];
    for (const tok of tokens) {
        if (targetSet.has(tok)) {
            out.push({__target:true, text: tok, features: featTuple});
        } else {
            out.push(tok);
        }
    }
    return out;
}

// -------------------------
// ユーティリティ: トークンを model-キー用に安定化
function tokenToKey(t) {
    if (typeof t === 'string') return JSON.stringify(t);
    if (typeof t === 'object' && t && t.__target) return JSON.stringify(['TARGET', t.text]);
    return JSON.stringify(String(t));
}

// -------------------------
// n-gram Markov 構築（オブジェクトトークンに対応）
function build_markov(tokens, n=2) {
    const trans = new Map();
    for (let i = 0; i < tokens.length - n; i++) {
        const keyArr = tokens.slice(i, i + n).map(tokenToKey);
        const key = JSON.stringify(keyArr);
        const next = tokens[i + n];
        if (!trans.has(key)) trans.set(key, []);
        trans.get(key).push(next);
    }
    return trans;
}

function sampleNext(arr){
    return arr[Math.floor(Math.random()*arr.length)];
}

// -------------------------
// トークンを自然テキストに変換（TARGETオブジェクトは .text を使う）
function tokenToText(t){
    if (typeof t === 'string') return t;
    if (typeof t === 'object' && t && t.__target) return t.text;
    return String(t);
}

// -------------------------
// ストリーミング生成（配列内のオブジェクトトークンをそのまま扱う）
async function generate_markov_streaming(trans, n, length=200, delay=0) {
    const keys = Array.from(trans.keys());
    if (keys.length === 0) {
        postMessage({type:"stream_end"});
        return;
    }

    let key = keys[Math.floor(Math.random()*keys.length)];
    let seqKeys = JSON.parse(key); // array of token keys

    // 再構築：キー配列から実際のトークンの "表示" を作るため、キーをそのまま使って出力
    // ここでは最初の n-gram をそのまま文字列にして送る
    for (const k of seqKeys) {
        // k is a JSON string of token representation
        try {
            const parsed = JSON.parse(k);
            if (Array.isArray(parsed) && parsed[0] === 'TARGET') {
                // parsed = ['TARGET', text]
                postMessage({type:"stream_token", token: parsed[1]});
            } else {
                postMessage({type:"stream_token", token: parsed});
            }
        } catch (err) {
            postMessage({type:"stream_token", token: String(k)});
        }
        if (delay>0) await new Promise(r=>setTimeout(r, delay));
    }

    // ここでは model の値配列に実際のトークンオブジェクト（string または object）を保存しているため、
    // key を更新するときは seq の最後の n 要素を tokenToKey でシリアライズする。
    let seq = seqKeys.slice(); // 現状は key 文字列配列

    for (let i=0;i<length-n;i++){
        const arr = trans.get(key);
        if(!arr || arr.length===0) break;

        const next = sampleNext(arr);

        // next may be object or string; when posting, convert to text
        postMessage({type:"stream_token", token: tokenToText(next)});
        if(delay>0) await new Promise(r=>setTimeout(r,delay));

        // update seq keys: drop first, append tokenToKey(next)
        seq.push(tokenToKey(next));
        seq = seq.slice(seq.length - n);
        key = JSON.stringify(seq);
    }

    postMessage({type:"stream_end"});
}

// -------------------------
// Worker メッセージ処理
onmessage = async function(e){
    const {type, text, input, params} = e.data;

    // 初期化
    if(type==="init"){
        learningChunks=[];
        const CHUNK_SIZE = (params && params.CHUNK_SIZE) || 80000;
        for(let i=0;i<text.length;i+=CHUNK_SIZE){
            learningChunks.push(text.slice(i,i+CHUNK_SIZE));
        }
        postMessage({type:"log", msg:`巨大テキストを ${learningChunks.length} チャンクに分割しました`});
    }

    // 生成
    if(type==="generate"){
        if(!input||input.trim()==="") return;

        // 1) ユーザ入力を全てトークン化してターゲット集合にする（max split = 3）
        const targetTokensArr = tokenize_input_as_targets(input);
        const targetSet = new Set(targetTokensArr);

        // 2) 全チャンクを通してトークナイズ（必要なら部分的にしても良い）
        let allTokens = [];
        for(const chunk of learningChunks){
            const toks = tokenize_chunk(chunk, 10); // 学習コーパスは maxTokenLen=10
            allTokens.push(...toks);
        }

        // 3) 周辺トークン統計
        const N = (params && params.N) || 50;
        const power = (params && params.power) || 4.0;
        const threshold = (params && params.threshold) || 1e-7;
        const {counts, totals} = build_context_counts_multi(allTokens, targetSet, N);
        const scores = compute_scores(counts, totals, power);
        const features = select_features(scores, threshold);

        // 4) 埋め込み
        const tokenized = embed_features_in_corpus(allTokens, targetSet, features);

        // 5) Markov 構築
        const model = build_markov(tokenized, ngram_n);

        // 6) ストリーミング生成
        const gen_length = (params && params.gen_length) || 200;
        const delay = (params && params.delay) || 0;
        generate_markov_streaming(model, ngram_n, gen_length, delay);
    }
};
