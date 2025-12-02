// ================================
// 300万文字対応 Web Worker（特徴込み Markov + 文頭/文末補正 + ストリーミング）
// ================================

let learningChunks = [];
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
// 入力トークナイザ（連続文字列を最大3文字に分割）
function tokenize_input_as_targets(text) {
    return tokenize_chunk(text, 3).filter(t => t !== "");
}

// -------------------------
// 周辺トークン統計
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
            arr.push({rel: parseInt(parts[0], 10), token: parts[1], score: sc});
        }
    }
    arr.sort((a, b) => (a.rel - b.rel) || (b.score - a.score) || a.token.localeCompare(b.token));
    return arr;
}

// -------------------------
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
function tokenToKey(t){
    if (typeof t === 'string') return JSON.stringify({t});
    if (typeof t === 'object' && t && t.__target) {
        return JSON.stringify({t: t.text, f: t.features});
    }
    return JSON.stringify(String(t));
}

// -------------------------
function build_markov(tokens, n=2){
    const trans = new Map();
    for(let i=0;i<tokens.length-n;i++){
        const keyArr = tokens.slice(i,i+n).map(tokenToKey);
        const key = JSON.stringify(keyArr);
        const next = tokens[i+n];
        if(!trans.has(key)) trans.set(key, []);
        trans.get(key).push(next);
    }
    return trans;
}

// -------------------------
function tokenToText(t){
    if(typeof t==='string') return t;
    if(typeof t==='object' && t && t.__target) return t.text;
    return String(t);
}

// -------------------------
// 文頭補正
function fix_start_tokens(tokens){
    const re = /[。！？!?…]/;
    for(let i=0;i<tokens.length-1;i++){
        if(re.test(tokenToText(tokens[i]))){
            return tokens.slice(i+1);
        }
    }
    return tokens;
}

// -------------------------
// 文末補正
function fix_end_tokens(tokens, trans, ngram_n, maxExtend=150){
    const re = /[。！？!?…]/;
    let seq = tokens.slice();
    for(let i=0;i<maxExtend;i++){
        const lastTokens = seq.slice(-12).map(tokenToText).join('');
        if(re.test(lastTokens)) break;
        if(seq.length<ngram_n) break;
        const key = JSON.stringify(seq.slice(seq.length-ngram_n).map(tokenToKey));
        const arr = trans.get(key);
        if(!arr || arr.length===0) break;
        const next = arr[Math.floor(Math.random()*arr.length)];
        seq.push(next);
    }
    return seq;
}

// -------------------------
// sampleNextWeighted（特徴込み）
function sampleNextWeighted(arr, targetSet){
    const weights = arr.map(tok => {
        let w = 1.0;
        if(typeof tok==='object' && tok.__target) w*=4.0;
        if(tok.features){
            for(const f of tok.features){
                if(targetSet.has(f.token)) w*=(1.0+f.score*5.0);
            }
        }
        return w;
    });
    const total = weights.reduce((a,b)=>a+b,0);
    let r = Math.random()*total;
    for(let i=0;i<arr.length;i++){
        r-=weights[i];
        if(r<=0) return arr[i];
    }
    return arr[arr.length-1];
}

// -------------------------
// ストリーミング生成
async function generate_markov_streaming(trans, n, length=200, delay=0, targetSet=null){
    const keys = Array.from(trans.keys());
    if(keys.length===0){postMessage({type:"stream_end"}); return;}

    let key = keys[Math.floor(Math.random()*keys.length)];
    let seqKeys = JSON.parse(key);
    const out = [];

    // 最初の n-gram
    for(const k of seqKeys){
        try{
            const parsed = JSON.parse(k);
            out.push(parsed);
            postMessage({type:"stream_token", token: tokenToText(parsed)});
        }catch{out.push(k); postMessage({type:"stream_token", token:String(k)});}
        if(delay>0) await new Promise(r=>setTimeout(r,delay));
    }

    let seq = seqKeys.slice();
    for(let i=0;i<length-n;i++){
        const arr = trans.get(key);
        if(!arr || arr.length===0) break;
        const next = targetSet ? sampleNextWeighted(arr,targetSet) : arr[Math.floor(Math.random()*arr.length)];
        seq.push(next);
        seq = seq.slice(seq.length-n);
        key = JSON.stringify(seq);
        postMessage({type:"stream_token", token: tokenToText(next)});
        if(delay>0) await new Promise(r=>setTimeout(r,delay));
    }

    postMessage({type:"stream_end"});
}

// -------------------------
// Worker メッセージ処理
onmessage = async function(e){
    const {type, text, input, params} = e.data;

    if(type==='init'){
        learningChunks=[];
        const CHUNK_SIZE = (params && params.CHUNK_SIZE) || 80000;
        for(let i=0;i<text.length;i+=CHUNK_SIZE){
            learningChunks.push(text.slice(i,i+CHUNK_SIZE));
        }
        postMessage({type:'log', msg:`巨大テキストを ${learningChunks.length} チャンクに分割しました`});
    }

    if(type==='generate'){
        if(!input||input.trim()==='') return;

        const targetTokensArr = tokenize_input_as_targets(input);
        const targetSet = new Set(targetTokensArr);

        let allTokens = [];
        for(const chunk of learningChunks){
            allTokens.push(...tokenize_chunk(chunk,10));
        }

        const N = (params&&params.N)||50;
        const power = (params&&params.power)||4.0;
        const threshold = (params&&params.threshold)||1e-7;
        const {counts, totals} = build_context_counts_multi(allTokens,targetSet,N);
        const scores = compute_scores(counts,totals,power);
        const features = select_features(scores,threshold);

        const tokenized = embed_features_in_corpus(allTokens,targetSet,features);
        const model = build_markov(tokenized,ngram_n);

        let tokens = seq = tokenized.slice(0, Math.min(ngram_n, tokenized.length));
        tokens = fix_start_tokens(tokens);
        tokens = fix_end_tokens(tokens, model, ngram_n, 200);

        const gen_length = (params&&params.gen_length)||200;
        const delay = (params&&params.delay)||0;
        generate_markov_streaming(model, ngram_n, gen_length, delay, targetSet);
    }
};