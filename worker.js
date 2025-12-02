// ================================
// 300万文字対応 Web Worker（長文対応版）
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
    while ((match = pattern.exec(chunk)) !== null) tokens.push(match[0]);
    return tokens;
}

// -------------------------
// 対象トークン周辺だけ抽出（チャンク単位で軽量化）
function extract_near_target_chunk(tokens, targetTokens, windowSize = 50) {
    const targetIndices = [];
    for (let i = 0; i < tokens.length; i++) {
        if (targetTokens.has(tokens[i])) targetIndices.push(i);
    }
    if (targetIndices.length === 0) return [];
    
    // 最初の出現位置だけ周辺を抽出
    const s = Math.max(0, targetIndices[0] - windowSize);
    const e = Math.min(tokens.length, targetIndices[0] + windowSize);
    return tokens.slice(s, e);
}

// -------------------------
// トークン出現回数カウント
function countTokens(tokens) {
    const counter = new Map();
    for (const t of tokens) counter.set(t, (counter.get(t)||0)+1);
    return counter;
}

// -------------------------
// 出現頻度で軽くフィルタ
function filterTokensByFreq(tokens, counter, power=1.5, threshold=1.0) {
    return tokens.filter(t => Math.pow(counter.get(t)||0, power) >= threshold);
}

// -------------------------
// 軽量 n-gram Markov
function build_markov(tokens, n = 2) {
    const trans = new Map();
    for (let i = 0; i < tokens.length - n; i++) {
        const key = tokens.slice(i, i+n).join("§"); // JSON.stringifyより高速
        const next = tokens[i+n];
        if (!trans.has(key)) trans.set(key, []);
        trans.get(key).push(next);
    }
    return trans;
}

function sampleNext(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// -------------------------
// ストリーミング生成（非同期でフリーズ防止）
async function generate_markov_streaming(trans, n, length=200, delay=0) {
    const keys = Array.from(trans.keys());
    if (keys.length === 0) {
        postMessage({type:"stream_end"});
        return;
    }

    let key = keys[Math.floor(Math.random()*keys.length)];
    let seq = key.split("§");

    // 最初の n-gram を送信
    for (let t of seq) {
        postMessage({type:"stream_token", token:t});
        if(delay>0) await new Promise(r=>setTimeout(r, delay));
    }

    for (let i=0; i<length-n; i++) {
        const arr = trans.get(key);
        if(!arr || arr.length===0) break;
        const next = sampleNext(arr);
        seq.push(next);
        postMessage({type:"stream_token", token:next});
        if(delay>0) await new Promise(r=>setTimeout(r, delay));
        key = seq.slice(seq.length-n).join("§");

        // 1チャンク処理ごとに少し待機してフリーズ回避
        if(i % 50 === 0) await new Promise(r=>setTimeout(r,0));
    }

    postMessage({type:"stream_end"});
}

// -------------------------
// Worker メッセージ処理
onmessage = async function(e){
    const {type, text, input} = e.data;

    // 初期化
    if(type==="init"){
        learningChunks=[];
        const CHUNK_SIZE=80000;
        for(let i=0;i<text.length;i+=CHUNK_SIZE){
            learningChunks.push(text.slice(i,i+CHUNK_SIZE));
        }
        postMessage({type:"log", msg:`巨大テキストを ${learningChunks.length} チャンクに分割しました`});
    }

    // 生成
    if(type==="generate"){
        if(!input||input.trim()==="") return;
        const targetTokens = new Set(tokenize_chunk(input));

        let near = [];
        // チャンク単位で対象トークン周辺だけ抽出
        for(const chunk of learningChunks){
            const toks = tokenize_chunk(chunk);
            const n = extract_near_target_chunk(toks, targetTokens, 50);
            near.push(...n);
            // 1チャンクごとに少し待つ
            await new Promise(r=>setTimeout(r,0));
        }

        const counter = countTokens(near);
        const filtered = filterTokensByFreq(near, counter, 1.5, 1.0);
        const model = build_markov(filtered, ngram_n);

        await generate_markov_streaming(model, ngram_n, 200, 0);
    }
};
