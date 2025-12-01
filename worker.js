// ================================
// 300万文字対応 Web Worker
// ================================

let learningChunks = [];         // 分割テキスト
let ngram_n = 2;

// -------------------------
// ストリーミング・トークナイザ
// -------------------------
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
// ターゲットの周辺だけ抽出（高速化のコア）
// -------------------------
function extract_near_target(allTokens, targetTokens, windowSize = 2000) {

    const targetIndices = [];
    for (let i = 0; i < allTokens.length; i++) {
        if (targetTokens.has(allTokens[i])) targetIndices.push(i);
    }

    if (targetIndices.length === 0)
        return allTokens.slice(0, 2000);

    let s = Math.max(0, targetIndices[0] - windowSize);
    let e = Math.min(allTokens.length, targetIndices[0] + windowSize);

    return allTokens.slice(s, e);
}

// -------------------------
// 軽量 n-gram Markov
// -------------------------
function build_markov(tokens, n = 2) {
    const trans = new Map();
    for (let i = 0; i < tokens.length - n; i++) {
        const key = JSON.stringify(tokens.slice(i, i + n));
        const next = tokens[i + n];
        if (!trans.has(key)) trans.set(key, []);
        trans.get(key).push(next);
    }
    return trans;
}

function sampleNext(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generate_markov_streaming(trans, n, length = 200) {
    const keys = Array.from(trans.keys());
    if (keys.length === 0) {
        postMessage({ type: "stream_end" });
        return;
    }

    let key = keys[Math.floor(Math.random() * keys.length)];
    let seq = JSON.parse(key);

    // 最初の n-gram をそのまま吐く（1つずつ）
    for (let t of seq) {
        postMessage({ type: "stream_token", token: t });
    }

    // 1トークンずつリアルタイム生成
    for (let i = 0; i < length - n; i++) {
        const arr = trans.get(key);
        if (!arr) break;

        let next = sampleNext(arr);
        seq.push(next);

        // ★ ここで1トークンリアルタイム送信！
        postMessage({ type: "stream_token", token: next });

        key = JSON.stringify(seq.slice(seq.length - n));
    }

    postMessage({ type: "stream_end" });
}


// -------------------------
// Worker コマンド
// -------------------------
onmessage = async function(e) {
    const { type, text, input } = e.data;

    // -------------------------
    // 初期化：巨大テキストを分割して保持
    // -------------------------
    if (type === "init") {
        learningChunks = [];

        // ★ 50,000〜100,000 文字ごとに分割
        const CHUNK_SIZE = 80000;

        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            learningChunks.push(text.slice(i, i + CHUNK_SIZE));
        }

        postMessage({
            type: "log",
            msg: "巨大テキストを " + learningChunks.length + " チャンクに分割しました"
        });
    }

    // -------------------------
    // 生成
    // -------------------------
    if (type === "generate") {

        // 対象トークン
        const targetTokens = new Set(tokenize_chunk(input));

        let allTokens = [];

        // ★ 分割されたチャンクを逐次トークナイズ
        for (const chunk of learningChunks) {
            const toks = tokenize_chunk(chunk);
            allTokens.push(...toks);
	const model = build_markov(near, ngram_n);
    	generate_markov_streaming(model, ngram_n, 200);
        }

        // ★ ターゲットの周辺だけ軽量抽出
        const near = extract_near_target(allTokens, targetTokens, 2000);

        // ★ Markov 構築
        const model = build_markov(near, ngram_n);

        // ★ 生成
        const seq = generate_markov(model, ngram_n, 200);
        const out = seq.join("");

        postMessage({ type: "result", msg: out });
    }
};
