// Client-side statistics for the campaign-manager Analytics page. Everything
// runs in the browser on the knock data already loaded — no server compute
// (Netlify only hosts static files + the one chat function), and at ~20k rows
// these are all sub-100ms.

/** Wilson score interval for a binomial proportion — the right CI for
 * "P(answer) on 312 knocks": never leaves [0,1], sane at small n. */
export function wilson(successes: number, n: number, z = 1.96): { p: number; lo: number; hi: number } {
  if (n === 0) return { p: 0, lo: 0, hi: 0 }
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) }
}

/** Simple ordinary-least-squares line fit. */
export interface LinearFit {
  slope: number
  intercept: number
  r2: number
  n: number
  predict: (x: number) => number
}

export function linearRegression(points: { x: number; y: number }[]): LinearFit | null {
  const n = points.length
  if (n < 2) return null
  let sx = 0
  let sy = 0
  for (const p of points) {
    sx += p.x
    sy += p.y
  }
  const mx = sx / n
  const my = sy / n
  let sxx = 0
  let sxy = 0
  let syy = 0
  for (const p of points) {
    sxx += (p.x - mx) ** 2
    sxy += (p.x - mx) * (p.y - my)
    syy += (p.y - my) ** 2
  }
  if (sxx === 0) return null
  const slope = sxy / sxx
  const intercept = my - slope * mx
  const r2 = syy === 0 ? 1 : (sxy * sxy) / (sxx * syy)
  return { slope, intercept, r2, n, predict: (x) => intercept + slope * x }
}

// ---------------------------------------------------------------------------
// Logistic regression — the Model Lab's engine. Binary outcome on a design
// matrix of user-picked features, fit by Newton–Raphson (IRLS). Fast and
// exact enough at this scale; L2 ridge keeps separated features from blowing
// up the weights.
// ---------------------------------------------------------------------------

export interface LogisticModel {
  /** coefficient per column, index 0 = intercept */
  weights: number[]
  /** names matching weights (first is 'intercept') */
  features: string[]
  n: number
  positives: number
  iterations: number
  converged: boolean
  auc: number
  accuracy: number
  /** model log-likelihood vs intercept-only (McFadden pseudo-R²) */
  pseudoR2: number
  predict: (row: number[]) => number
}

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z))

/**
 * Fit P(y=1 | x) with an intercept prepended automatically.
 * X rows are raw feature vectors (no leading 1); standardization happens
 * internally so odds ratios come back on the original feature scale.
 */
export function logisticRegression(
  X: number[][],
  y: number[],
  featureNames: string[],
  opts: { maxIter?: number; ridge?: number } = {},
): LogisticModel | null {
  const n = X.length
  if (n === 0 || X[0].length !== featureNames.length) return null
  const k = featureNames.length + 1 // + intercept
  const maxIter = opts.maxIter ?? 30
  const ridge = opts.ridge ?? 1e-4

  // Standardize columns (mean 0, sd 1) for stable Newton steps.
  const means = new Array(k - 1).fill(0)
  const sds = new Array(k - 1).fill(1)
  for (let j = 0; j < k - 1; j++) {
    let s = 0
    for (let i = 0; i < n; i++) s += X[i][j]
    means[j] = s / n
    let v = 0
    for (let i = 0; i < n; i++) v += (X[i][j] - means[j]) ** 2
    sds[j] = Math.sqrt(v / n) || 1
  }
  const design = X.map((row) => [1, ...row.map((v, j) => (v - means[j]) / sds[j])])

  let w = new Array(k).fill(0)
  let iterations = 0
  let converged = false

  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1
    // gradient and Hessian
    const grad = new Array(k).fill(0)
    const hess: number[][] = Array.from({ length: k }, () => new Array(k).fill(0))
    for (let i = 0; i < n; i++) {
      const xi = design[i]
      let z = 0
      for (let j = 0; j < k; j++) z += w[j] * xi[j]
      const p = sigmoid(z)
      const err = y[i] - p
      const wgt = Math.max(p * (1 - p), 1e-9)
      for (let j = 0; j < k; j++) {
        grad[j] += err * xi[j]
        for (let m = j; m < k; m++) hess[j][m] += wgt * xi[j] * xi[m]
      }
    }
    for (let j = 0; j < k; j++) {
      grad[j] -= ridge * w[j]
      hess[j][j] += ridge
      for (let m = 0; m < j; m++) hess[j][m] = hess[m][j]
    }
    const step = solve(hess, grad)
    if (!step) break
    let maxStep = 0
    for (let j = 0; j < k; j++) {
      w[j] += step[j]
      maxStep = Math.max(maxStep, Math.abs(step[j]))
    }
    if (maxStep < 1e-6) {
      converged = true
      break
    }
  }

  // De-standardize so predict() takes raw feature rows.
  const weights = new Array(k).fill(0)
  for (let j = 1; j < k; j++) weights[j] = w[j] / sds[j - 1]
  weights[0] = w[0]
  for (let j = 1; j < k; j++) weights[0] -= (w[j] * means[j - 1]) / sds[j - 1]

  const predict = (row: number[]) => {
    let z = weights[0]
    for (let j = 0; j < row.length; j++) z += weights[j + 1] * row[j]
    return sigmoid(z)
  }

  // Fit quality
  const probs = X.map(predict)
  const positives = y.reduce((a, b) => a + b, 0)
  let correct = 0
  let ll = 0
  for (let i = 0; i < n; i++) {
    const p = Math.min(Math.max(probs[i], 1e-12), 1 - 1e-12)
    ll += y[i] ? Math.log(p) : Math.log(1 - p)
    if ((probs[i] >= 0.5 ? 1 : 0) === y[i]) correct++
  }
  const base = positives / n
  const llNull =
    positives * Math.log(Math.max(base, 1e-12)) + (n - positives) * Math.log(Math.max(1 - base, 1e-12))

  return {
    weights,
    features: ['intercept', ...featureNames],
    n,
    positives,
    iterations,
    converged,
    auc: auc(probs, y),
    accuracy: correct / n,
    pseudoR2: llNull === 0 ? 0 : Math.max(0, 1 - ll / llNull),
    predict,
  }
}

/** Gaussian elimination with partial pivoting; null if singular. */
function solve(A: number[][], b: number[]): number[] | null {
  const k = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let col = 0; col < k; col++) {
    let piv = col
    for (let r = col + 1; r < k; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r
    if (Math.abs(M[piv][col]) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv], M[col]]
    for (let r = 0; r < k; r++) {
      if (r === col) continue
      const f = M[r][col] / M[col][col]
      for (let c = col; c <= k; c++) M[r][c] -= f * M[col][c]
    }
  }
  return M.map((row, i) => row[k] / M[i][i])
}

/** Area under the ROC curve via the rank-sum (Mann–Whitney) identity. */
export function auc(scores: number[], labels: number[]): number {
  const pairs = scores.map((s, i) => ({ s, y: labels[i] })).sort((a, b) => a.s - b.s)
  let rank = 1
  let sumRanksPos = 0
  let nPos = 0
  let i = 0
  while (i < pairs.length) {
    // average ranks over ties
    let j = i
    while (j < pairs.length - 1 && pairs[j + 1].s === pairs[i].s) j++
    const avgRank = (rank + rank + (j - i)) / 2
    for (let m = i; m <= j; m++) {
      if (pairs[m].y === 1) {
        sumRanksPos += avgRank
        nPos++
      }
    }
    rank += j - i + 1
    i = j + 1
  }
  const nNeg = pairs.length - nPos
  if (nPos === 0 || nNeg === 0) return 0.5
  return (sumRanksPos - (nPos * (nPos + 1)) / 2) / (nPos * nNeg)
}

/** Calibration curve: bucket predictions into `bins` and compare predicted
 * vs observed rates — the honest "is the model lying" chart. */
export function calibration(
  probs: number[],
  labels: number[],
  bins = 10,
): { predicted: number; observed: number; n: number }[] {
  const buckets = Array.from({ length: bins }, () => ({ sumP: 0, sumY: 0, n: 0 }))
  probs.forEach((p, i) => {
    const b = Math.min(bins - 1, Math.floor(p * bins))
    buckets[b].sumP += p
    buckets[b].sumY += labels[i]
    buckets[b].n++
  })
  return buckets
    .filter((b) => b.n > 0)
    .map((b) => ({ predicted: b.sumP / b.n, observed: b.sumY / b.n, n: b.n }))
}

/** Trailing moving average, window centered on nothing fancy — used for the
 * 7-day signature trend line. */
export function rollingMean(values: number[], window: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < window - 1) return null
    let s = 0
    for (let j = i - window + 1; j <= i; j++) s += values[j]
    return s / window
  })
}
