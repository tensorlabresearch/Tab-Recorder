import { describe, it, expect } from "vitest";
import {
  clusterEmbeddings,
  cosineDistance,
  DEFAULT_CLUSTER_OPTIONS
} from "../extension/lib/embeddingCluster.js";

// Helpers: build d-dim Float32Array embeddings clustered around prototypes.
const PROTO = {
  a: [1, 0, 0, 0],
  b: [0, 1, 0, 0],
  c: [0, 0, 1, 0]
};

function makeEmbedding(proto, jitter = 0.02, seed = 1) {
  let s = seed;
  const next = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  return new Float32Array(proto.map((v) => v + (next() - 0.5) * jitter));
}

describe("DEFAULT_CLUSTER_OPTIONS", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_CLUSTER_OPTIONS)).toBe(true);
  });

  it("documents the agreed defaults", () => {
    expect(DEFAULT_CLUSTER_OPTIONS.metric).toBe("cosine");
    expect(DEFAULT_CLUSTER_OPTIONS.linkage).toBe("average");
    expect(DEFAULT_CLUSTER_OPTIONS.threshold).toBe(0.4);
    expect(DEFAULT_CLUSTER_OPTIONS.maxClusters).toBe(8);
  });
});

describe("cosineDistance", () => {
  it("returns 0 for identical vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    expect(cosineDistance(a, a)).toBeCloseTo(0, 6);
  });

  it("returns ~1 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineDistance(a, b)).toBeCloseTo(1, 6);
  });

  it("returns 2 for opposite vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([-1, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(2, 6);
  });

  it("returns 1 for zero vectors (no direction defined)", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 1, 1]);
    expect(cosineDistance(a, b)).toBe(1);
  });

  it("returns 1 for zero-length vectors", () => {
    expect(cosineDistance(new Float32Array([]), new Float32Array([]))).toBe(1);
  });

  it("uses min-length when shapes differ", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([1, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(0, 6);
  });
});

describe("clusterEmbeddings — degenerate inputs", () => {
  it("returns an empty Int32Array for empty input", () => {
    const out = clusterEmbeddings([]);
    expect(out).toBeInstanceOf(Int32Array);
    expect(out.length).toBe(0);
  });

  it("returns [0] for a single embedding", () => {
    const out = clusterEmbeddings([makeEmbedding(PROTO.a)]);
    expect(Array.from(out)).toEqual([0]);
  });

  it("returns [] for non-array / nullish input", () => {
    expect(clusterEmbeddings(null).length).toBe(0);
    expect(clusterEmbeddings(undefined).length).toBe(0);
    expect(clusterEmbeddings({}).length).toBe(0);
    expect(clusterEmbeddings("nope").length).toBe(0);
  });

  it("ignores entries that aren't a numeric vector", () => {
    const out = clusterEmbeddings([
      makeEmbedding(PROTO.a),
      null,
      "garbage",
      [1, NaN, 3],
      makeEmbedding(PROTO.a)
    ]);
    // Only two valid embeddings survived → one cluster.
    expect(out.length).toBe(2);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
  });
});

describe("clusterEmbeddings — clean separation", () => {
  it("groups identical embeddings into one cluster", () => {
    const e = makeEmbedding(PROTO.a);
    const out = clusterEmbeddings([e, e, e, e]);
    expect(Array.from(out)).toEqual([0, 0, 0, 0]);
  });

  it("separates two clearly distinct prototypes", () => {
    const a1 = makeEmbedding(PROTO.a, 0.02, 11);
    const a2 = makeEmbedding(PROTO.a, 0.02, 12);
    const b1 = makeEmbedding(PROTO.b, 0.02, 21);
    const b2 = makeEmbedding(PROTO.b, 0.02, 22);
    const out = clusterEmbeddings([a1, b1, a2, b2]);
    expect(out[0]).toBe(0);
    expect(out[2]).toBe(0); // same proto as a1
    expect(out[1]).toBe(1);
    expect(out[3]).toBe(1); // same proto as b1
  });

  it("separates three clearly distinct prototypes", () => {
    const inputs = [
      makeEmbedding(PROTO.a, 0.02, 11),
      makeEmbedding(PROTO.b, 0.02, 21),
      makeEmbedding(PROTO.c, 0.02, 31),
      makeEmbedding(PROTO.a, 0.02, 12),
      makeEmbedding(PROTO.b, 0.02, 22),
      makeEmbedding(PROTO.c, 0.02, 32)
    ];
    const out = clusterEmbeddings(inputs);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(0);
    expect(out[4]).toBe(1);
    expect(out[5]).toBe(2);
  });
});

describe("clusterEmbeddings — stability and ordering", () => {
  it("is deterministic across runs", () => {
    const inputs = [
      makeEmbedding(PROTO.a, 0.05, 11),
      makeEmbedding(PROTO.b, 0.05, 21),
      makeEmbedding(PROTO.a, 0.05, 12),
      makeEmbedding(PROTO.b, 0.05, 22)
    ];
    const a = clusterEmbeddings(inputs);
    const b = clusterEmbeddings(inputs);
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it("assigns cluster IDs in first-appearance order", () => {
    // First input is B, second input is A — so B's cluster should be 0.
    const inputs = [
      makeEmbedding(PROTO.b, 0.02, 21),
      makeEmbedding(PROTO.a, 0.02, 11),
      makeEmbedding(PROTO.b, 0.02, 22),
      makeEmbedding(PROTO.a, 0.02, 12)
    ];
    const out = clusterEmbeddings(inputs);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(0);
    expect(out[3]).toBe(1);
  });
});

describe("clusterEmbeddings — option overrides", () => {
  it("respects a stricter threshold (forces more clusters)", () => {
    // threshold: -1 means "every pair is too far apart" because cosine
    // distance is always >= 0. Every embedding stays its own cluster
    // (capped by maxClusters, but the default 8 leaves plenty of room).
    const inputs = [
      makeEmbedding(PROTO.a, 0.02, 1),
      makeEmbedding(PROTO.a, 0.02, 2),
      makeEmbedding(PROTO.a, 0.02, 3),
      makeEmbedding(PROTO.a, 0.02, 4)
    ];
    const out = clusterEmbeddings(inputs, { threshold: -1 });
    expect(new Set(Array.from(out)).size).toBe(4);
  });

  it("honors maxClusters cap when threshold would allow more clusters", () => {
    // Use a threshold so tight that nothing would merge naturally.
    const inputs = [
      makeEmbedding(PROTO.a, 0.02, 1),
      makeEmbedding(PROTO.b, 0.02, 2),
      makeEmbedding(PROTO.c, 0.02, 3),
      makeEmbedding(PROTO.a, 0.02, 4),
      makeEmbedding(PROTO.b, 0.02, 5)
    ];
    const out = clusterEmbeddings(inputs, {
      threshold: 0.0001,
      maxClusters: 2
    });
    expect(new Set(Array.from(out)).size).toBeLessThanOrEqual(2);
  });

  it("merges to a single cluster when prototypes are very close", () => {
    // All inputs near PROTO.a — should collapse to one cluster.
    const inputs = [
      makeEmbedding(PROTO.a, 0.02, 1),
      makeEmbedding(PROTO.a, 0.02, 2),
      makeEmbedding(PROTO.a, 0.02, 3)
    ];
    const out = clusterEmbeddings(inputs);
    expect(new Set(Array.from(out)).size).toBe(1);
  });
});

describe("clusterEmbeddings — input shape tolerance", () => {
  it("accepts plain number arrays", () => {
    const out = clusterEmbeddings([
      [1, 0, 0],
      [1, 0.01, 0],
      [0, 1, 0]
    ]);
    expect(out.length).toBe(3);
    expect(out[0]).toBe(0);
    expect(out[1]).toBe(0);
    expect(out[2]).toBe(1);
  });

  it("accepts Float64Array", () => {
    const out = clusterEmbeddings([
      new Float64Array([1, 0]),
      new Float64Array([1, 0])
    ]);
    expect(Array.from(out)).toEqual([0, 0]);
  });

  it("returns Int32Array", () => {
    const out = clusterEmbeddings([
      makeEmbedding(PROTO.a),
      makeEmbedding(PROTO.b)
    ]);
    expect(out).toBeInstanceOf(Int32Array);
  });
});
