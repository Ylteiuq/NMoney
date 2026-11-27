"""以商户、商品的 TF-IDF 和对数金额为特征，用余弦相似度对支出分组。"""

from collections import Counter, defaultdict
import math
import re
import unicodedata


def grams(value):
    text = unicodedata.normalize("NFKC", value or "").lower()
    words = re.findall(r"[^\W_]+", re.sub(r"\d{4,}", " ", text), re.UNICODE)
    result = {}
    for word in words:
        if len(word) == 1:
            result[word] = None
        else:
            for i in range(len(word) - 1):
                result[word[i:i + 2]] = None
    return list(result)


def clustered_rows(rows):
    documents = []
    frequency = Counter()
    for row in sorted((r for r in rows if r["outflow"]), key=lambda r: r["id"]):
        terms = {}
        for field, weight in (("merchant", 1), ("product", 1.25)):
            tokens = grams(row[field])
            for token in tokens:
                terms[field, token] = weight / math.sqrt(len(tokens))
        frequency.update(terms.keys())
        documents.append((row, terms))

    groups, sums, norms = [], [], []
    index = defaultdict(dict)
    for row, terms in documents:
        vector = {key: tf * (1 + math.log((1 + len(documents)) / (1 + frequency[key])))
                  for key, tf in terms.items()}
        price = math.log2(1 + row["cents"] / 100)
        band = math.floor(price)
        vector["price", band] = 1 - (price - band)
        vector["price", band + 1] = price - band
        length = math.hypot(*vector.values())
        vector = {key: value / length for key, value in vector.items()}

        # 候选必须共享文本。固定候选遍历顺序，让相同输入总是得到相同分组。
        candidates = dict.fromkeys(i for term in terms for i in index[term])
        best, threshold, best_dot = None, 0.68, 0
        for i in candidates:
            dot = sum(value * sums[i].get(key, 0) for key, value in vector.items())
            similarity = dot / math.sqrt(norms[i])
            if similarity >= threshold:
                best, threshold, best_dot = i, similarity, dot
        if best is None:
            best = len(groups)
            groups.append([])
            sums.append(defaultdict(float))
            norms.append(0)
        groups[best].append(row)
        norms[best] += 1 + 2 * best_dot
        for key, value in vector.items():
            sums[best][key] += value
        for term in terms:
            index[term][best] = None
    return sorted(groups, key=lambda group: (-len(group), group[0]["id"]))
