// ================================
// Web Worker: Pythonマルコフ忠実移植版
// ================================

let learningText = "";  // まとめた学習テキスト
let conversationLog = "";
let maxTokenLen = 8;
let ngram_n = 5;

// -------------------------
// 日本語トークナイザ
// -------------------------
function tokenizeJapanese(text, maxTokenLen = 10) {
    const pattern = /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|\w+|\s|[^\w\s]/g;
    const tokens = [];
    let match;
    while ((match = pattern.exec(text)) !== null) {
        let tok = match[0];
        if (tok.length > maxTokenLen && !tok.match(/^\s$/) && !tok.match(/^[^\w\s]$/)) {
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
// 周辺トークン統計（Pythonのbuild_context_counts_multi）  
// targets: Set
function buildContextCounts(tokens, targets, N=50) {
    const counts = new Map();
    const totals = new Map();
    for (let idx = 0; idx < tokens.length; idx++) {
        if (!targets.has(tokens[idx])) continue;
        for (let rel = -N; rel <= N; rel++) {
            if (rel === 0) continue;
            const pos = idx + rel;
            if (pos < 0 || pos >= tokens.length) continue;
            const key = `${rel}§${tokens[pos]}`;
            counts.set(key, (counts.get(key) || 0) + 1);
            totals.set(rel, (totals.get(rel) || 0) + 1);
        }
    }
    return { counts, totals };
}

// -------------------------
// スコア計算
function computeScores(counts, totals, power=4.0) {
    const scores = new Map();
    counts.forEach((cnt, key) => {
        const [relStr, tok] = key.split('§');
        const rel = parseInt(relStr);
        const tot = totals.get(rel) || 1;
        scores.set(key, Math.pow(cnt / tot, power));
    });
    return scores;
}

// -------------------------
// フィーチャー選択
function selectFeatures(scores, threshold=1e-7) {
    const kept = [];
    scores.forEach((sc, key) => {
        if (sc >= threshold) {
            const [relStr, tok] = key.split('§');
            kept.push({ rel: parseInt(relStr), tok, score: sc });
        }
    });
    kept.sort((a,b) => a.rel - b.rel || b.score - a.score || a.tok.localeCompare(b.tok));
    return kept;
}

// -------------------------
// ターゲット埋め込み
function embedFeaturesInCorpus(tokens, targets, features, perOccurrence=false) {
    const out = [];
    if (!perOccurrence) {
        const featureTuple = features.map(f => [f.rel, f.tok, f.score]);
        tokens.forEach(tok => {
            if (targets.has(tok)) {
                out.push(["TARGET", featureTuple, tok]);
            } else {
                out.push(tok);
            }
        });
    } else {
        const N = Math.max(...features.map(f => Math.abs(f.rel)), 0);
        for (let i=0; i<tokens.length; i++){
            const tok = tokens[i];
            if (!targets.has(tok)) {
                out.push(tok);
                continue;
            }
            const local_feats = [];
            for (let rel=-N; rel<=N; rel++){
                if (rel===0) continue;
                const pos=i+rel;
                if (pos<0 || pos>=tokens.length) continue;
                local_feats.push([rel, tokens[pos], 1.0]);
            }
            out.push(["TARGET", local_feats, tok]);
        }
    }
    return out;
}

// -------------------------
// n-gram Markov
function buildMarkovNgram(tokens, n=2){
    const trans = new Map();
    for (let i=0; i<tokens.length-n; i++){
        const key = tokens.slice(i,i+n).map(t => JSON.stringify(t)).join("§");
        const nxt = tokens[i+n];
        if (!trans.has(key)) trans.set(key, new Map());
        const counter = trans.get(key);
        counter.set(nxt, (counter.get(nxt)||0)+1);
    }
    return trans;
}

function sampleNext(counterMap){
    const entries = Array.from(counterMap.entries());
    const total = entries.reduce((a,b)=>a+b[1],0);
    let r = Math.random()*total;
    let cum=0;
    for (const [k,v] of entries){
        cum += v;
        if (r<=cum) return k;
    }
    return entries[Math.floor(Math.random()*entries.length)][0];
}

// -------------------------
// Markov生成
function generateMarkovNgram(trans, n=2, length=200, start=null){
    if (trans.size===0) return [];
    const keys = Array.from(trans.keys());
    let key = start || keys[Math.floor(Math.random()*keys.length)];
    let seq = key.split("§").map(k => JSON.parse(k));

    for (let i=0;i<length-n;i++){
        const k = seq.slice(-n).map(t => JSON.stringify(t)).join("§");
        let counter = trans.get(k);
        if (!counter || counter.size===0){
            key = keys[Math.floor(Math.random()*keys.length)];
            counter = trans.get(key);
        }
        seq.push(sampleNext(counter));
    }
    return seq;
}

// -------------------------
// tokens→text
function tokensToText(tokens){
    return tokens.map(t=>{
        if (Array.isArray(t) && t[0]==="TARGET") return t[2];
        return t.toString();
    }).join("");
}

// -------------------------
// ターゲット混ぜ込み
function injectTargets(tokens, targetTokensSet, times=13){
    let out = tokens.slice();
    const tgtArr = Array.from(targetTokensSet);
    for (let i=0;i<times;i++){
        const pos = Math.floor(Math.random()*out.length);
        out = [...out.slice(0,pos), ...tgtArr, ...out.slice(pos)];
    }
    return out;
}

// -------------------------
// Web Workerメッセージ処理
onmessage = async function(e){
    const { type, folderTexts, conversationLogText, input, ngram=4, genLength=100 } = e.data;

    if (type==="init"){
        learningText = folderTexts.join("\n");
        conversationLog = conversationLogText || "";
        maxTokenLen = 8;
        ngram_n = ngram || 4;
        postMessage({ type:"log", msg:`学習テキスト長: ${learningText.length} 文字` });
    }

    if (type==="generate"){
        if (!input || input.trim()==="") return;

        // ターゲットトークン化
        const targetTokens = new Set(tokenizeJapanese(input, maxTokenLen));

        // 学習テキスト＋会話ログ
        let tokens = tokenizeJapanese(learningText+"\n"+conversationLog, maxTokenLen);

        // ターゲット混ぜ込み
        tokens = injectTargets(tokens, targetTokens, 800);

        // 周辺統計
        const { counts, totals } = buildContextCounts(tokens, targetTokens, 50);
        const scores = computeScores(counts, totals, 4.0);
        const features = selectFeatures(scores, 1e-7);

        // 埋め込み
        const embedded = embedFeaturesInCorpus(tokens, targetTokens, features, false);

        // Markov構築
        const model = buildMarkovNgram(embedded, ngram_n);

        // 生成
        const seq = generateMarkovNgram(model, ngram_n, genLength);

        const textOut = tokensToText(seq);
        postMessage({ type:"result", text: textOut });
    }
};






