let learningText = "";
let ngram_n = 2;

// -------------------------
// Python と同じ日本語トークナイザ
// -------------------------
function tokenize_japanese(text, maxTokenLen = 10) {
    if (!text) return [];
    const pattern = /[\u4E00-\u9FFF]+|[\u3040-\u309F]+|[\u30A0-\u30FF]+|\w+|\s|[^\w\s]/g;

    let tokens = [];
    const matches = text.match(pattern) || [];

    for (let tok of matches) {
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
// 周辺統計（Python版そのまま）
// -------------------------
function build_context_counts_multi(tokens, targets, N = 50) {
    const counts = new Map();
    const totals = new Map();
    const L = tokens.length;

    for (let idx = 0; idx < L; idx++) {
        if (!targets.has(tokens[idx])) continue;

        for (let rel = -N; rel <= N; rel++) {
            if (rel === 0) continue;
            const pos = idx + rel;
            if (pos < 0 || pos >= L) continue;

            const key = rel + "||" + tokens[pos];
            counts.set(key, (counts.get(key) || 0) + 1);
            totals.set(rel, (totals.get(rel) || 0) + 1);
        }
    }
    return { counts, totals };
}

// -------------------------
// スコア計算
// -------------------------
function compute_scores(counts, totals, power = 1.0) {
    const scores = new Map();

    for (let [key, cnt] of counts) {
        const [relStr, tok] = key.split("||");
        const rel = parseInt(relStr);
        const tot = totals.get(rel) || 0;
        if (tot === 0) continue;

        const prob = cnt / tot;
        scores.set(key, Math.pow(prob, power));
    }
    return scores;
}

// -------------------------
// 特徴抽出（しきい値）
// -------------------------
function select_features(scores, threshold = 1e-7) {
    let arr = [];

    for (let [key, score] of scores) {
        if (score >= threshold) {
            const [relStr, tok] = key.split("||");
            arr.push({ rel: parseInt(relStr), tok, score });
        }
    }

    arr.sort((a, b) => {
        if (a.rel !== b.rel) return a.rel - b.rel;
        if (a.score !== b.score) return b.score - a.score;
        return a.tok.localeCompare(b.tok);
    });

    return arr;
}

// -------------------------
// 特徴埋め込み（Pythonと完全同じ構造）
// -------------------------
function embed_features_in_corpus(tokens, targets, features) {
    const featureTuple = features.map(f => [f.rel, f.tok, f.score]);
    const out = [];

    for (let tok of tokens) {
        if (targets.has(tok)) {
            out.push(["TARGET", featureTuple, tok]);
        } else {
            out.push(tok);
        }
    }
    return out;
}

// -------------------------
// n-gram マルコフ
// -------------------------
function build_markov_ngram(tokens, n) {
    const trans = new Map();

    for (let i = 0; i < tokens.length - n; i++) {
        const key = JSON.stringify(tokens.slice(i, i + n));
        const nxt = tokens[i + n];

        if (!trans.has(key)) trans.set(key, []);
        trans.get(key).push(nxt);
    }
    return trans;
}

function sampleNext(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function generate_markov(trans, n, length) {
    const keys = Array.from(trans.keys());
    if (keys.length === 0) return [];

    let key = keys[Math.floor(Math.random() * keys.length)];
    let seq = JSON.parse(key);

    for (let i = 0; i < length - n; i++) {
        if (!trans.has(key)) break;
        const nextArr = trans.get(key);
        const next = sampleNext(nextArr);
        seq.push(next);

        const nextKey = JSON.stringify(seq.slice(seq.length - n));
        key = nextKey;
    }
    return seq;
}

// -------------------------
// TARGET → 自然文
// -------------------------
function tokens_to_text_natural(tokens) {
    return tokens.map(t => {
        if (Array.isArray(t) && t[0] === "TARGET") return t[2];
        return t;
    }).join("");
}

// -------------------------
// ターゲット混ぜ込み
// -------------------------
function inject_targets(sourceText, targetTokens, times = 1000) {
    let tokens = tokenize_japanese(sourceText);
    const arr = Array.from(targetTokens);

    for (let i = 0; i < times; i++) {
        const pos = Math.floor(Math.random() * tokens.length);
        tokens.splice(pos, 0, ...arr);
    }
    return tokens.join("");
}

// -------------------------
// メイン生成ステップ（Python版完全再現）
// -------------------------
function generate_step(source_text, target_strings) {
    const maxTokenLen = 10;
    const N = 50;
    const power = 4.0;
    const threshold = 1e-7;

    const targetTokens = new Set();
    for (let s of target_strings) {
        tokenize_japanese(s).forEach(t => targetTokens.add(t));
    }

    const tokens = tokenize_japanese(source_text);
    const { counts, totals } = build_context_counts_multi(tokens, targetTokens, N);
    const scores = compute_scores(counts, totals, power);
    const features = select_features(scores, threshold);
    const tokenized = embed_features_in_corpus(tokens, targetTokens, features);

    const model = build_markov_ngram(tokenized, ngram_n);
    const seq = generate_markov(model, ngram_n, 300);
    return tokens_to_text_natural(seq);
}

// -------------------------
// Worker メイン
// -------------------------
onmessage = function(e) {
    const { type, text, input } = e.data;

    if (type === "init") {
        learningText = text;
        postMessage({ type: "log", msg: "Python互換 Worker 初期化完了" });
    }

    if (type === "generate") {
        const modified = inject_targets(learningText, new Set(tokenize_japanese(input)), 1000);
        const out = generate_step(modified, [input]);
        postMessage({ type: "result", msg: out });
    }
};
