// ================================
// 300万文字対応 Web Worker（ターゲット埋め込み + Markov + 文整形 + ストリーミング）
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
// 入力ワード専用トークナイザ（最大3文字スプリット）
function tokenize_input_as_targets(text) {
    return tokenize_chunk(text, 3).filter(t => t !== "");
}

// -------------------------
// 周辺文脈統計
function build_context_counts_multi(tokens, targetSet, N) {
    const counts = new Map();
    const totals = new Map();
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
    const scores = new Map();
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
    arr.sort((a, b) => (a.rel - b.rel) || (b.score - a.score) || a.token.localeCompare(b.token));
    return arr;
}

// -------------------------
// 特徴埋め込み（全ターゲット同一特徴）
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
// Markov 用シリアライズ
function tokenToKey(t) {
    if (typeof t === 'string') return JSON.stringify(t);
    if (typeof t === 'object' && t && t.__target) return JSON.stringify(['TARGET', t.text]);
    return JSON.stringify(String(t));
}

// -------------------------
// Markov 構築
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
// 自然テキスト化
function tokenToText(t){
    if (typeof t === 'string') return t;
    if (typeof t === 'object' && t && t.__target) return t.text;
    return String(t);
}

// ========================================================
// ★★ 文整形モジュール追加（自然な文頭／文末処理）★★
// ========================================================

// 文頭らしい開始キーを選ぶ（句点・改行の直後）
function pick_sentence_start(keys) {
    const cands = [];
    for (const k of keys) {
        try {
            const arr = JSON.parse(k);
            const first = JSON.parse(arr[0]);
            if (typeof first === "string" && first.match(/^[。！？\n]/)) {
                cands.push(k);
            }
        } catch(e){}
    }
    if (cands.length > 0) {
        return cands[Math.floor(Math.random() * cands.length)];
    }
    return keys[Math.floor(Math.random() * keys.length)];
}

// 文頭整形：句読点単体などを削る／文末記号の後から開始
function clean_stream_start(buffer) {
    const text = buffer.join("");

    // 文末記号の直後から開始（最も自然）
    const m = text.match(/[。！？]\s*(.*)$/s);
    if (m && m[1]) {
        return m[1].split("");
    }

    // 句読点で始まるなら削除
    return text.replace(/^[、。！？\s]+/, "").split("");
}

function is_sentence_end(ch) {
    return /[。！？]/.test(ch);
}

// ========================================================
// ★★ ストリーミング生成（文頭整形＋文末延長付き）★★
// ========================================================
async function generate_markov_streaming(trans, n, length=200, delay=0) {

    const keys = Array.from(trans.keys());
    if (keys.length === 0) {
        postMessage({type:"stream_end"});
        return;
    }

    // 文頭らしい開始位置を使う
    let key = pick_sentence_start(keys);
    let seqKeys = JSON.parse(key);

    let outputBuffer = [];

    // 最初の n-gram をバッファへ
    for (const k of seqKeys) {
        try {
            const parsed = JSON.parse(k);
            if (Array.isArray(parsed) && parsed[0]==='TARGET') {
                outputBuffer.push(parsed[1]);
            } else {
                outputBuffer.push(parsed);
            }
        } catch(e){
            outputBuffer.push(String(k));
        }
    }

    let seq = seqKeys.slice();

    // 本体生成
    for (let i=0;i<length-n;i++){
        const arr = trans.get(key);
        if(!arr || arr.length===0) break;

        const next = sampleNext(arr);
        outputBuffer.push(tokenToText(next));

        seq.push(tokenToKey(next));
        seq = seq.slice(seq.length - n);
        key = JSON.stringify(seq);
    }

    // ★ 文頭整形 ★
    outputBuffer = clean_stream_start(outputBuffer);

    // ★ 文末まで延長（最大100トークン）★
    let extra = 0;
    while (!is_sentence_end(outputBuffer[outputBuffer.length - 1]) && extra < 100) {
        const arr = trans.get(key);
        if(!arr || arr.length===0) break;

        const next = sampleNext(arr);
        outputBuffer.push(tokenToText(next));

        seq.push(tokenToKey(next));
        seq = seq.slice(seq.length - n);
        key = JSON.stringify(seq);

        extra++;
    }

    // ストリーム送信
    for (const ch of outputBuffer) {
        postMessage({type:"stream_token", token: ch});
        if(delay>0) await new Promise(r=>setTimeout(r, delay));
    }

    postMessage({type:"stream_end"});
}

// ========================================================
// Worker メッセージ処理
// ========================================================
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

        // 1) 入力をターゲット化
        const targetTokensArr = tokenize_input_as_targets(input);
        const targetSet = new Set(targetTokensArr);

        // 2) 全チャンクのトークン化
        let allTokens = [];
        for(const chunk of learningChunks){
            const toks = tokenize_chunk(chunk, 10);
            allTokens.push(...toks);
        }

        // 3) 特徴抽出
        const N = (params && params.N) || 50;
        const power = (params && params.power) || 4.0;
        const threshold = (params && params.threshold) || 1e-7;

        const {counts, totals} = build_context_counts_multi(allTokens, targetSet, N);
        const scores = compute_scores(counts, totals, power);
        const features = select_features(scores, threshold);

        // 4) 埋め込み
        const tokenized = embed_features_in_corpus(allTokens, targetSet, features);

        // 5) Markov モデル構築
        const model = build_markov(tokenized, ngram_n);

        // 6) ストリーミング生成（文整形つき）
        const gen_length = (params && params.gen_length) || 200;
        const delay = (params && params.delay) || 0;
        generate_markov_streaming(model, ngram_n, gen_length, delay);
    }
};
