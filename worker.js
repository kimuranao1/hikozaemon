// ================================
// 300万文字対応 Web Worker
// （ターゲットトークン埋め込み + 緩い Markov +
//   文頭/文末の自然文整形 + ストリーミング）
// ================================

let learningChunks = [];
let ngram_n = 2;

// -------------------------
// 汎用トークナイザ
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
// 入力をターゲット化（最大3文字）
function tokenize_input_as_targets(text) {
    return tokenize_chunk(text, 3).filter(t => t !== "");
}

// -------------------------
// 周辺統計
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
    return { counts, totals };
}

// -------------------------
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
function select_features(scores, threshold) {
    const arr = [];
    for (const [k, sc] of scores.entries()) {
        if (sc >= threshold) {
            const parts = k.split('\u0000');
            arr.push({ rel: parseInt(parts[0], 10), token: parts[1], score: sc });
        }
    }
    arr.sort((a, b) =>
        (a.rel - b.rel) ||
        (b.score - a.score) ||
        a.token.localeCompare(b.token)
    );
    return arr;
}

// -------------------------
// 埋め込み
function embed_features_in_corpus(tokens, targetSet, features) {
    const featTuple = features.map(f => ({ rel: f.rel, token: f.token, score: f.score }));
    const out = [];
    for (const tok of tokens) {
        if (targetSet.has(tok)) {
            out.push({ __target: true, text: tok, features: featTuple });
        } else {
            out.push(tok);
        }
    }
    return out;
}

// -------------------------
function tokenToKey(t) {
    if (typeof t === "string") return JSON.stringify(t);
    if (typeof t === "object" && t && t.__target) return JSON.stringify(["TARGET", t.text]);
    return JSON.stringify(String(t));
}

// -------------------------
function build_markov(tokens, n = 2) {
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

function sampleNext(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

// -------------------------
function tokenToText(t) {
    if (typeof t === "string") return t;
    if (typeof t === "object" && t && t.__target) return t.text;
    return String(t);
}

//
// ================================
// ▼ 追加：整形ロジック
// ================================
//

// 文頭補正：句読点・記号の連続などを除去し、自然な文頭っぽいところから開始
function fix_start_tokens(tokens) {
    const textTokens = tokens.map(tokenToText);

    const startIndex = (() => {
        const re = /[。！？!?…]\s*$/;
        for (let i = 0; i < textTokens.length - 1; i++) {
            if (re.test(textTokens[i])) return i + 1;
        }
        return 0;
    })();

    return tokens.slice(startIndex);
}

// 文末補正：文末記号が出るまで追加生成
async function fix_end_tokens(tokens, trans, maxExtend = 100) {
    const endRe = /[。！？!?…]/;

    const isEnd = () => endRe.test(tokens.map(tokenToText).join(""));

    if (isEnd()) return tokens;

    let seq = tokens.map(tokenToKey);
    for (let i = 0; i < maxExtend; i++) {
        if (seq.length < ngram_n) break;
        const key = JSON.stringify(seq.slice(seq.length - ngram_n));
        const arr = trans.get(key);
        if (!arr || arr.length === 0) break;

        const next = sampleNext(arr);
        tokens.push(next);
        seq.push(tokenToKey(next));

        if (isEnd()) break;
    }
    return tokens;
}

// Markov 生成（ストリーミング前に全バッファ生成）
async function generate_markov_buffer(trans, n, length) {
    const keys = Array.from(trans.keys());
    if (keys.length === 0) return [];

    let key = keys[Math.floor(Math.random() * keys.length)];
    let seqKeys = JSON.parse(key);

    const out = [];

    // initial n grams
    for (const k of seqKeys) {
        try {
            const parsed = JSON.parse(k);
            if (Array.isArray(parsed) && parsed[0] === "TARGET") out.push({ __target: true, text: parsed[1] });
            else out.push(parsed);
        } catch {
            out.push(k);
        }
    }

    let seq = seqKeys.slice();
    for (let i = 0; i < length - n; i++) {
        const arr = trans.get(key);
        if (!arr || arr.length === 0) break;

        const next = sampleNext(arr);
        out.push(next);

        seq.push(tokenToKey(next));
        seq = seq.slice(seq.length - n);
        key = JSON.stringify(seq);
    }

    return out;
}

// 整形後にストリーミング
async function stream_fixed_tokens(tokens, delay) {
    for (const t of tokens) {
        postMessage({ type: "stream_token", token: tokenToText(t) });
        if (delay > 0) await new Promise(r => setTimeout(r, delay));
    }
    postMessage({ type: "stream_end" });
}

//
// ================================
// Worker メッセージ処理
// ================================
//
onmessage = async function (e) {
    const { type, text, input, params } = e.data;

    if (type === "init") {
        learningChunks = [];
        const CHUNK_SIZE = (params && params.CHUNK_SIZE) || 80000;
        for (let i = 0; i < text.length; i += CHUNK_SIZE) {
            learningChunks.push(text.slice(i, i + CHUNK_SIZE));
        }
        postMessage({ type: "log", msg: `${learningChunks.length} チャンクに分割しました` });
    }

    if (type === "generate") {
        if (!input || input.trim() === "") return;

        const targetTokensArr = tokenize_input_as_targets(input);
        const targetSet = new Set(targetTokensArr);

        let allTokens = [];
        for (const chunk of learningChunks) {
            const toks = tokenize_chunk(chunk, 10);
            allTokens.push(...toks);
        }

        const N = (params && params.N) || 50;
        const power = (params && params.power) || 4.0;
        const threshold = (params && params.threshold) || 1e-7;
        const gen_length = (params && params.gen_length) || 200;
        const delay = (params && params.delay) || 0;

        const { counts, totals } = build_context_counts_multi(allTokens, targetSet, N);
        const scores = compute_scores(counts, totals, power);
        const features = select_features(scores, threshold);

        const tokenized = embed_features_in_corpus(allTokens, targetSet, features);
        const model = build_markov(tokenized, ngram_n);

        // 生成（バッファ）
        let tokens = await generate_markov_buffer(model, ngram_n, gen_length);

        // 文頭補正
        tokens = fix_start_tokens(tokens);

        // 文末補正
        tokens = await fix_end_tokens(tokens, model, 100);

        // ストリーミング
        await stream_fixed_tokens(tokens, delay);
    }
};
