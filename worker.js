@@ -1,17 +1,15 @@
// ================================
// 300万文字対応 Web Worker（ストリーミング最適化）
// 300万文字対応 Web Worker（緩い Markov + ストリーミング）
// ================================

let learningChunks = [];  // 分割テキスト
let ngram_n = 2;

// -------------------------
// 日本語対応トークナイザ
// -------------------------
function tokenize_chunk(chunk, maxTokenLen = 10) {
    const pattern = /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|\w+|\s|[^\w\s]/g;
    const tokens = [];

    let match;
    while ((match = pattern.exec(chunk)) !== null) {
        let tok = match[0];
@@ -27,8 +25,8 @@ function tokenize_chunk(chunk, maxTokenLen = 10) {
}

// -------------------------
// 対象トークン周辺だけ抽出（高速化）
function extract_near_target(allTokens, targetTokens, windowSize = 10) {
// 対象トークン周辺抽出
function extract_near_target(allTokens, targetTokens, windowSize = 2000) {
    const targetIndices = [];
    for (let i = 0; i < allTokens.length; i++) {
        if (targetTokens.has(allTokens[i])) targetIndices.push(i);
@@ -37,103 +35,138 @@ function extract_near_target(allTokens, targetTokens, windowSize = 10) {
    if (targetIndices.length === 0)
        return allTokens.slice(0, windowSize);

    const s = Math.max(0, targetIndices[0] - windowSize);
    const e = Math.min(allTokens.length, targetIndices[0] + windowSize);
    return allTokens.slice(s, e);
    // 複数ターゲットを考慮して統合
    let ranges = targetIndices.map(idx => [
        Math.max(0, idx - windowSize),
        Math.min(allTokens.length, idx + windowSize)
    ]);

    // 範囲をマージ
    ranges.sort((a,b) => a[0]-b[0]);
    let merged = [];
    let cur = ranges[0];
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] <= cur[1]) {
            cur[1] = Math.max(cur[1], ranges[i][1]);
        } else {
            merged.push(cur);
            cur = ranges[i];
        }
    }
    merged.push(cur);

    // マージ後のトークン抽出
    let near = [];
    for (const [s,e] of merged) near.push(...allTokens.slice(s,e));
    return near;
}

// -------------------------
// トークン出現回数カウント
function countTokens(tokens) {
    const counter = new Map();
    for (const t of tokens) counter.set(t, (counter.get(t)||0)+1);
    return counter;
}

// -------------------------
// 出現頻度に応じて緩くフィルタ
function filterTokensByFreq(tokens, counter, power=1.5, threshold=1.0) {
    return tokens.filter(t => Math.pow(counter.get(t)||0, power) >= threshold);
}

// -------------------------
// 軽量 n-gram Markov
function build_markov(tokens, n = 2) {
function build_markov(tokens, n=2) {
    const trans = new Map();
    for (let i = 0; i < tokens.length - n; i++) {
        const key = JSON.stringify(tokens.slice(i, i + n));
        const next = tokens[i + n];
    for (let i=0;i<tokens.length-n;i++){
        const key = JSON.stringify(tokens.slice(i,i+n));
        const next = tokens[i+n];
        if (!trans.has(key)) trans.set(key, []);
        trans.get(key).push(next);
    }
    return trans;
}

function sampleNext(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
function sampleNext(arr){
    return arr[Math.floor(Math.random()*arr.length)];
}

// -------------------------
// ストリーミング生成
function generate_markov_streaming(trans, n, length = 200) {
async function generate_markov_streaming(trans, n, length=200, delay=0) {
    const keys = Array.from(trans.keys());
    if (keys.length === 0) {
        postMessage({ type: "stream_end" });
    if (keys.length===0){
        postMessage({type:"stream_end"});
        return;
    }

    let key = keys[Math.floor(Math.random() * keys.length)];
    let key = keys[Math.floor(Math.random()*keys.length)];
    let seq = JSON.parse(key);

    // 最初の n-gram をそのまま送信
    for (let t of seq) {
        postMessage({ type: "stream_token", token: t });
    // 最初の n-gram を順番に送信
    for (let t of seq){
        postMessage({type:"stream_token", token:t});
        if(delay>0) await new Promise(r=>setTimeout(r,delay));
    }

    // 1トークンずつ生成
    for (let i = 0; i < length - n; i++) {
    for (let i=0;i<length-n;i++){
        const arr = trans.get(key);
        if (!arr || arr.length === 0) break;
        if(!arr || arr.length===0) break;

        const next = sampleNext(arr);
        seq.push(next);

        postMessage({ type: "stream_token", token: next });
        postMessage({type:"stream_token", token:next});
        if(delay>0) await new Promise(r=>setTimeout(r,delay));

        key = JSON.stringify(seq.slice(seq.length - n));
        key = JSON.stringify(seq.slice(seq.length-n));
    }

    postMessage({ type: "stream_end" });
    postMessage({type:"stream_end"});
}

// -------------------------
// Worker メッセージ処理
onmessage = async function(e) {
    const { type, text, input } = e.data;

    // -------------------------
    // 初期化：巨大テキストを分割して保持
    if (type === "init") {
        learningChunks = [];
        const CHUNK_SIZE = 80000; // 8万文字ごとに分割
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            learningChunks.push(text.slice(i, i + CHUNK_SIZE));
onmessage = async function(e){
    const {type, text, input} = e.data;

    // 初期化
    if(type==="init"){
        learningChunks=[];
        const CHUNK_SIZE=80000;
        for(let i=0;i<text.length;i+=CHUNK_SIZE){
            learningChunks.push(text.slice(i,i+CHUNK_SIZE));
        }

        postMessage({
            type: "log",
            msg: `巨大テキストを ${learningChunks.length} チャンクに分割しました`
        });
        postMessage({type:"log", msg:`巨大テキストを ${learningChunks.length} チャンクに分割しました`});
    }

    // -------------------------
    // 生成
    if (type === "generate") {
        if (!input || input.trim() === "") return;
    if(type==="generate"){
        if(!input||input.trim()==="") return;

        // 入力をトークナイズして対象トークンセット作成
        const targetTokens = new Set(tokenize_chunk(input));

        // チャンクを順にトークナイズして結合
        let allTokens = [];
        for (const chunk of learningChunks) {
        // チャンク順にトークナイズして結合（軽量化のため部分的にでもOK）
        let allTokens=[];
        for(const chunk of learningChunks){
            const toks = tokenize_chunk(chunk);
            allTokens.push(...toks);
        }

        // 対象トークン周辺だけ抽出して軽量化
        const near = extract_near_target(allTokens, targetTokens, 10);
        // 対象周辺抽出
        let near = extract_near_target(allTokens, targetTokens, 50);

        // トークン頻度カウント
        const counter = countTokens(near);

        // 緩くフィルタ
        const filtered = filterTokensByFreq(near, counter, 1.5, 1.0);

        // Markov構築
        const model = build_markov(near, ngram_n);
        const model = build_markov(filtered, ngram_n);

        // ストリーミング生成
        generate_markov_streaming(model, ngram_n, 200);
        generate_markov_streaming(model, ngram_n, 200, 0);
    }
};