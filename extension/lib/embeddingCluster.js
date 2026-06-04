// Agglomerative clustering for speaker embeddings. Naive O(n^2) build of
// the pairwise distance matrix, then iterative closest-pair merging with
// Lance-Williams average linkage. Stops when the smallest remaining merge
// distance exceeds `threshold`, unless `maxClusters` would still be
// exceeded (in which case it keeps merging cheapest-first until at or
// below the cap).
//
// Output cluster IDs are assigned by first-appearance in the input order
// (the first input's cluster is always 0, the next unseen cluster is 1,
// etc.) so labels like "Speaker 1 / 2 / ..." are stable for downstream
// transcript annotation.

export const DEFAULT_CLUSTER_OPTIONS = Object.freeze({
  // Only cosine distance is implemented today. The option exists so PR4
  // can layer in alternatives (e.g. PLDA) without changing the API.
  metric: "cosine",
  // Only Lance-Williams average linkage is implemented today.
  linkage: "average",
  // Stop merging once the cheapest remaining pair distance is above this.
  threshold: 0.4,
  // Hard cap on the number of clusters in the output. Forces extra merges
  // if threshold-based stopping would leave more than this many clusters.
  maxClusters: 8
});

export function clusterEmbeddings(embeddings, opts = {}) {
  const { threshold, maxClusters } = { ...DEFAULT_CLUSTER_OPTIONS, ...opts };

  const points = normalizeEmbeddings(embeddings);
  const n = points.length;
  if (n === 0) return new Int32Array(0);
  if (n === 1) return new Int32Array([0]);

  // members[i] is the Set of original indices that currently belong to
  // active cluster `i`. Inactive clusters have members === null.
  const members = points.map((_, i) => new Set([i]));
  const active = new Set(points.map((_, i) => i));

  // Symmetric distance matrix. dist[i][j] === dist[j][i].
  const dist = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = cosineDistance(points[i], points[j]);
      dist[i][j] = d;
      dist[j][i] = d;
    }
  }

  while (active.size > 1) {
    let bestA = -1;
    let bestB = -1;
    let bestD = Infinity;
    const activeArr = Array.from(active);
    for (let ai = 0; ai < activeArr.length; ai++) {
      for (let bi = ai + 1; bi < activeArr.length; bi++) {
        const i = activeArr[ai];
        const j = activeArr[bi];
        if (dist[i][j] < bestD) {
          bestD = dist[i][j];
          bestA = i;
          bestB = j;
        }
      }
    }
    if (bestA < 0) break;

    // Stop if the cheapest pair is too far apart AND we're already within
    // the cluster-count cap. Above the cap we keep merging cheapest-first.
    if (bestD > threshold && active.size <= maxClusters) break;

    const sizeA = members[bestA].size;
    const sizeB = members[bestB].size;
    const sizeSum = sizeA + sizeB;
    for (const k of active) {
      if (k === bestA || k === bestB) continue;
      const newD = (sizeA * dist[bestA][k] + sizeB * dist[bestB][k]) / sizeSum;
      dist[bestA][k] = newD;
      dist[k][bestA] = newD;
    }
    for (const m of members[bestB]) members[bestA].add(m);
    members[bestB] = null;
    active.delete(bestB);
  }

  // Assign cluster IDs by first-appearance in original input order.
  const idByOriginal = new Int32Array(n);
  const clusterIdForActive = new Map();
  let nextId = 0;
  for (let orig = 0; orig < n; orig++) {
    let owner = -1;
    for (const a of active) {
      if (members[a].has(orig)) {
        owner = a;
        break;
      }
    }
    if (!clusterIdForActive.has(owner)) {
      clusterIdForActive.set(owner, nextId++);
    }
    idByOriginal[orig] = clusterIdForActive.get(owner);
  }
  return idByOriginal;
}

function normalizeEmbeddings(embeddings) {
  if (!Array.isArray(embeddings)) return [];
  const out = [];
  for (const e of embeddings) {
    if (e instanceof Float32Array) {
      out.push(e);
    } else if (e instanceof Float64Array) {
      out.push(new Float32Array(e));
    } else if (Array.isArray(e) && e.every((v) => Number.isFinite(v))) {
      out.push(new Float32Array(e));
    }
  }
  return out;
}

export function cosineDistance(a, b) {
  const len = Math.min(a.length, b.length);
  if (len === 0) return 1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 1;
  const sim = dot / (Math.sqrt(na) * Math.sqrt(nb));
  // Clamp to [0, 2] to absorb floating-point drift.
  if (sim > 1) return 0;
  if (sim < -1) return 2;
  return 1 - sim;
}
