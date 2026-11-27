"use strict";

// 字符二元组适合没有空格的中文商品名，订单流水号不参与相似度。
function clusterOutflows(rows) {
  const documents = [];
  const frequency = new Map();
  const terms = value => {
    const words = String(value || "").normalize("NFKC").toLowerCase().replace(/\d{4,}/g, " ")
      .match(/[\p{L}\d]+/gu) || [];
    const grams = new Set();
    for (const w of words) {
      if (w.length === 1) grams.add(w);
      for (let i = 1; i < w.length; i++) grams.add(w.slice(i - 1, i + 1));
    }
    return [...grams];
  };
  for (const row of rows.filter(r => r.outflow).sort((a, b) => a.id - b.id)) {
    const text = new Map();
    for (const [prefix, value, weight] of [["商", row.merchant, 1], ["品", row.product, 1.25]]) {
      const grams = terms(value);
      for (const g of grams) text.set(prefix + g, weight / Math.sqrt(grams.length));
    }
    for (const key of text.keys()) frequency.set(key, (frequency.get(key) || 0) + 1);
    documents.push({row, text});
  }
  const clusters = [];
  const index = new Map();
  for (const {row, text} of documents) {
    const vector = new Map();
    for (const [key, tf] of text) {
      const idf = 1 + Math.log((1 + documents.length) / (1 + frequency.get(key)));
      vector.set(key, tf * idf);
    }
    // 对数金额让相近价位平滑过渡。只有共享商户或商品文本的交易才互为候选。
    const price = Math.log2(1 + row.cents / 100);
    const band = Math.floor(price);
    vector.set("价" + band, 1 - (price - band));
    vector.set("价" + (band + 1), price - band);
    const norm = Math.hypot(...vector.values());
    for (const [key, value] of vector) vector.set(key, value / norm);
    const candidates = new Set();
    for (const key of text.keys()) for (const c of index.get(key) || []) candidates.add(c);
    let best = null;
    let bestScore = 0.68;
    let bestDot = 0;
    for (const c of candidates) {
      let dot = 0;
      for (const [key, value] of vector) dot += value * (c.sum.get(key) || 0);
      const cosine = dot / Math.sqrt(c.squaredNorm);
      if (cosine < bestScore) continue;
      best = c;
      bestScore = cosine;
      bestDot = dot;
    }
    if (!best) {
      best = {rows: [], sum: new Map(), squaredNorm: 0};
      clusters.push(best);
    }
    best.rows.push(row);
    best.squaredNorm += 1 + 2 * bestDot;
    for (const [key, value] of vector) best.sum.set(key, (best.sum.get(key) || 0) + value);
    for (const key of text.keys()) {
      if (!index.has(key)) index.set(key, new Set());
      index.get(key).add(best);
    }
  }
  return clusters.map(c => c.rows).sort((a, b) => b.length - a.length || a[0].id - b[0].id);
}

// Node 初分命令和浏览器使用同一份纯函数。
if (typeof module !== "undefined") module.exports = {clusterOutflows};
