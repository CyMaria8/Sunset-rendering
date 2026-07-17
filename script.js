const canvas = document.getElementById("skyCanvas");
const ctx = canvas.getContext("2d", { alpha: false });

const controls = {
  sunElevation: document.getElementById("sunElevation"),
  sunAzimuth: document.getElementById("sunAzimuth"),
  aerosolDensity: document.getElementById("aerosolDensity"),
  particleSize: document.getElementById("particleSize"),
  horizonHeight: document.getElementById("horizonHeight"),
  horizonScene: document.getElementById("horizonScene"),
  exposure: document.getElementById("exposure"),
  ozoneAbsorption: document.getElementById("ozoneAbsorption")
};

const outputs = {
  sunElevation: document.getElementById("sunElevationValue"),
  sunAzimuth: document.getElementById("sunAzimuthValue"),
  aerosolDensity: document.getElementById("aerosolDensityValue"),
  particleSize: document.getElementById("particleSizeValue"),
  horizonHeight: document.getElementById("horizonHeightValue"),
  exposure: document.getElementById("exposureValue")
};

const renderTitle = document.getElementById("renderTitle");
const timeLapseStatus = document.getElementById("timeLapseStatus");
const redBlueReadout = document.getElementById("redBlueReadout");
const timeLapseValue = document.getElementById("timeLapseValue");
const timelineFill = document.getElementById("timelineFill");
const playSunsetButton = document.getElementById("playSunset");
const resetSunsetButton = document.getElementById("resetSunset");
const photoUpload = document.getElementById("photoUpload");
const photoPreview = document.getElementById("photoPreview");
const photoPreviewCtx = photoPreview.getContext("2d", { willReadFrequently: true });
const inverseStatus = document.getElementById("inverseStatus");
const estimateZenith = document.getElementById("estimateZenith");
const estimateAod = document.getElementById("estimateAod");
const estimateRadius = document.getElementById("estimateRadius");
const estimateSunAngle = document.getElementById("estimateSunAngle");
const estimateHorizon = document.getElementById("estimateHorizon");
const estimateConfidence = document.getElementById("estimateConfidence");
const inverseNote = document.getElementById("inverseNote");
const applyEstimateButton = document.getElementById("applyEstimate");
const matchList = document.getElementById("matchList");
const tabButtons = Array.from(document.querySelectorAll(".tab-button"));
const tabPanels = Array.from(document.querySelectorAll(".tab-panel"));
let renderQueued = false;
let lastParamSignature = "";
let sunElevationProgrammatic = false;
let inverseEstimate = null;
let selectedMatchIndex = 0;
let draggedGuide = null;

const photoState = {
  loaded: false,
  draw: { x: 0, y: 0, width: 0, height: 0 },
  imageData: null,
  sunMask: null,
  horizonY: 0.72,
  guides: {
    upper: { x: 0.5, y: 0.22, label: "Upper" },
    sunDisk: { x: 0.5, y: 0.58, label: "Sun disk" }
  }
};

const timeLapse = {
  playing: false,
  rafId: 0,
  startTime: 0,
  duration: 18000,
  startElevation: 8,
  endElevation: -8
};

const silhouetteAssets = {
  forest: { src: "assets/single-pine-tree-silhouette.jpg", image: new Image(), loaded: false },
  mountains: { src: "assets/mountain-ridge-silhouette.png", image: new Image(), loaded: false },
  beach: { src: "assets/palm-beach-silhouette.jpg", image: new Image(), loaded: false }
};

Object.values(silhouetteAssets).forEach((asset) => {
  asset.image.onload = () => {
    asset.loaded = true;
    queueRender();
  };
  asset.image.src = asset.src;
});

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, x) {
  const t = clamp((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

function mixColor(a, b, t) {
  return [
    mix(a[0], b[0], t),
    mix(a[1], b[1], t),
    mix(a[2], b[2], t)
  ];
}

function normalize(v) {
  const len = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function getParams() {
  return Object.fromEntries(
    Object.entries(controls).map(([key, input]) => [
      key,
      input.tagName === "SELECT" ? input.value : input.type === "checkbox" ? input.checked : Number(input.value)
    ])
  );
}

function getParamSignature() {
  return Object.entries(controls)
    .map(([key, input]) => `${key}:${input.type === "checkbox" ? input.checked : input.value}`)
    .join("|");
}

function sunsetProgress(sunElevation) {
  return clamp(
    (timeLapse.startElevation - sunElevation) /
      (timeLapse.startElevation - timeLapse.endElevation)
  );
}

function estimateRedBlueIndex(params) {
  const progress = sunsetProgress(params.sunElevation);
  const nearHorizonBoost = Math.pow(progress, 1.65) * 3.85;
  const aerosolBoost = params.aerosolDensity * (0.24 + progress * 0.92);
  const sizeWashout = params.particleSize * (0.22 + progress * 0.18);
  return Math.max(0.25, 0.78 + nearHorizonBoost + aerosolBoost - sizeWashout);
}

function rgbToFeatures(color) {
  const r = color[0] / 255;
  const g = color[1] / 255;
  const b = color[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const sum = Math.max(0.001, r + g + b);

  return {
    r,
    g,
    b,
    rn: r / sum,
    gn: g / sum,
    bn: b / sum,
    brightness: max,
    saturation: max === 0 ? 0 : (max - min) / max,
    warmth: (r - b) / Math.max(0.001, max)
  };
}

function colorDistance(a, b) {
  return (
    Math.abs(a.rn - b.rn) * 1.5 +
    Math.abs(a.gn - b.gn) * 0.7 +
    Math.abs(a.bn - b.bn) * 1.5 +
    Math.abs(a.saturation - b.saturation) * 0.7 +
    Math.abs(a.warmth - b.warmth) * 0.8
  );
}

function averageSample(data, width, height, region, options = {}) {
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  const x0 = Math.floor(width * region.x0);
  const x1 = Math.floor(width * region.x1);
  const y0 = Math.floor(height * region.y0);
  const y1 = Math.floor(height * region.y1);
  const step = Math.max(1, Math.floor(Math.min(width, height) / 90));

  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const i = (y * width + x) * 4;
      const pr = data[i];
      const pg = data[i + 1];
      const pb = data[i + 2];
      const bright = Math.max(pr, pg, pb);
      const dark = Math.min(pr, pg, pb);
      const normalizedY = y / Math.max(1, height - 1);
      if (bright < 32 || dark > 246) continue;
      if (options.skyOnly && normalizedY > options.horizonY + 0.02) continue;
      if (options.mask && options.mask[y * width + x]) continue;
      r += pr;
      g += pg;
      b += pb;
      count++;
    }
  }

  if (!count) return null;
  return [r / count, g / count, b / count];
}

function regionAround(point, width = 0.28, height = 0.16) {
  return {
    x0: clamp(point.x - width / 2, 0, 1),
    x1: clamp(point.x + width / 2, 0, 1),
    y0: clamp(point.y - height / 2, 0, 1),
    y1: clamp(point.y + height / 2, 0, 1)
  };
}

function detectSunMask(imageData, horizonY) {
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;
  const mask = new Uint8Array(width * height);
  let sx = 0;
  let sy = 0;
  let count = 0;

  for (let y = 0; y < Math.floor(height * horizonY); y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const bright = Math.max(r, g, b);
      const warm = r - b;
      if (bright > 226 && warm > 18) {
        sx += x;
        sy += y;
        count++;
      }
    }
  }

  if (!count) return { mask, center: null, radius: 0 };

  const cx = sx / count;
  const cy = sy / count;
  const radius = clamp(Math.sqrt(count / Math.PI) * 3.4, 10, Math.min(width, height) * 0.22);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x - cx, y - cy) <= radius) {
        mask[y * width + x] = 1;
      }
    }
  }

  return { mask, center: { x: cx / width, y: cy / height }, radius: radius / Math.max(width, height) };
}

function sunMaskFromGuide(imageData) {
  const width = imageData.width;
  const height = imageData.height;
  const draw = photoState.draw;
  const centerX = draw.x + photoState.guides.sunDisk.x * draw.width;
  const centerY = draw.y + photoState.guides.sunDisk.y * draw.height;
  const radius = Math.max(10, Math.min(width, height) * 0.08);
  const mask = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x - centerX, y - centerY) <= radius) {
        mask[y * width + x] = 1;
      }
    }
  }

  return {
    mask,
    center: { x: centerX / width, y: centerY / height },
    radius: radius / Math.max(width, height)
  };
}

function detectHorizonY(imageData) {
  const data = imageData.data;
  const width = imageData.width;
  const height = imageData.height;
  const rowLuma = [];

  for (let y = 0; y < height; y++) {
    let total = 0;
    let count = 0;
    for (let x = Math.floor(width * 0.12); x < Math.floor(width * 0.88); x += 3) {
      const i = (y * width + x) * 4;
      total += data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      count++;
    }
    rowLuma.push(total / Math.max(1, count));
  }

  let bestY = Math.floor(height * 0.72);
  let bestDrop = 0;
  for (let y = Math.floor(height * 0.38); y < Math.floor(height * 0.9); y++) {
    const above = rowLuma[Math.max(0, y - 5)];
    const below = rowLuma[Math.min(height - 1, y + 5)];
    const drop = above - below;
    if (drop > bestDrop) {
      bestDrop = drop;
      bestY = y;
    }
  }

  return clamp(bestY / Math.max(1, height - 1), 0.42, 0.9);
}

function readExifFocalLength35mm(buffer) {
  try {
    const view = new DataView(buffer);
    if (view.getUint16(0, false) !== 0xffd8) return null;

    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset, false);
      if (marker !== 0xffe1) {
        offset += 2 + view.getUint16(offset + 2, false);
        continue;
      }

      const exifStart = offset + 4;
      if (view.getUint32(exifStart, false) !== 0x45786966) return null;
      const tiffOffset = exifStart + 6;
      const little = view.getUint16(tiffOffset, false) === 0x4949;
      const get16 = (o) => view.getUint16(o, little);
      const get32 = (o) => view.getUint32(o, little);
      if (get16(tiffOffset + 2) !== 0x002a) return null;

      const ifd0Offset = tiffOffset + get32(tiffOffset + 4);
      const entries0 = get16(ifd0Offset);
      let exifIfdOffset = null;
      for (let i = 0; i < entries0; i++) {
        const entryOffset = ifd0Offset + 2 + i * 12;
        if (get16(entryOffset) === 0x8769) {
          exifIfdOffset = tiffOffset + get32(entryOffset + 8);
          break;
        }
      }
      if (exifIfdOffset == null) return null;

      const entriesExif = get16(exifIfdOffset);
      for (let i = 0; i < entriesExif; i++) {
        const entryOffset = exifIfdOffset + 2 + i * 12;
        if (get16(entryOffset) === 0xa405) {
          return get16(entryOffset + 8);
        }
      }
      return null;
    }
    return null;
  } catch (err) {
    return null;
  }
}

function computeVerticalFovDegrees(focalLength35mm, imageWidth, imageHeight) {
  if (!focalLength35mm || focalLength35mm <= 0 || !imageWidth || !imageHeight) return null;
  const horizontalFov = 2 * Math.atan(36 / (2 * focalLength35mm));
  const aspect = imageHeight / imageWidth;
  const verticalFov = 2 * Math.atan(Math.tan(horizontalFov / 2) * aspect);
  return (verticalFov * 180) / Math.PI;
}

const GRADIENT_BAND_COUNT = 5;

function buildGradientBands() {
  const topY = clamp(photoState.guides.upper.y, 0.02, 0.9);
  const bottomY = clamp(photoState.horizonY - 0.04, topY + 0.05, 0.95);
  const span = bottomY - topY;
  const bands = [];
  for (let i = 0; i < GRADIENT_BAND_COUNT; i++) {
    const t = (i + 0.5) / GRADIENT_BAND_COUNT;
    bands.push({
      t,
      y: mix(topY, bottomY, t),
      height: Math.max(0.04, (span / GRADIENT_BAND_COUNT) * 0.9)
    });
  }
  return bands;
}

function photoBandRegion(band) {
  const draw = photoState.draw;
  const drawScaleX = draw.width / photoPreview.width;
  const drawScaleY = draw.height / photoPreview.height;
  const center = {
    x: (draw.x + draw.width * 0.5) / photoPreview.width,
    y: (draw.y + band.y * draw.height) / photoPreview.height
  };
  return regionAround(center, 0.56 * drawScaleX, band.height * drawScaleY);
}

function linearSlope(points) {
  const n = points.length;
  if (n < 2) return 0;
  const meanT = points.reduce((sum, p) => sum + p.t, 0) / n;
  const meanV = points.reduce((sum, p) => sum + p.v, 0) / n;
  let num = 0;
  let den = 0;
  points.forEach((p) => {
    num += (p.t - meanT) * (p.v - meanV);
    den += (p.t - meanT) * (p.t - meanT);
  });
  return den ? num / den : 0;
}

function buildSignatureFromBands(bandSamples) {
  const valid = bandSamples.filter(Boolean);
  if (!valid.length) return null;

  const tMin = Math.min(...valid.map((v) => v.t));
  const tMax = Math.max(...valid.map((v) => v.t));
  const span = Math.max(0.001, tMax - tMin);
  const warmthSlope = linearSlope(valid.map((v) => ({ t: v.t, v: v.features.warmth })));
  const brightnessSlope = linearSlope(valid.map((v) => ({ t: v.t, v: v.features.brightness })));
  const lowest = valid.reduce((a, b) => (b.t > a.t ? b : a));

  return {
    bands: valid,
    redBlue: lowest.features.r / Math.max(0.001, lowest.features.b),
    warmthGradient: warmthSlope * span,
    brightnessGradient: brightnessSlope * span
  };
}

function buildPhotoSignature(imageData) {
  const bands = buildGradientBands();
  const canvasHorizonY = (photoState.draw.y + photoState.horizonY * photoState.draw.height) / photoPreview.height;
  const options = {
    skyOnly: true,
    horizonY: canvasHorizonY,
    mask: photoState.sunMask ? photoState.sunMask.mask : null
  };

  const bandSamples = bands.map((band) => {
    const region = photoBandRegion(band);
    const color = averageSample(imageData.data, imageData.width, imageData.height, region, options);
    return color ? { t: band.t, features: rgbToFeatures(color) } : null;
  });

  return buildSignatureFromBands(bandSamples);
}

function sampleModelColor(params, region) {
  const width = 80;
  const height = 50;
  const sunDir = sunDirection(params);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;

  for (let yi = 0; yi < 5; yi++) {
    for (let xi = 0; xi < 7; xi++) {
      const xNorm = mix(region.x0, region.x1, (xi + 0.5) / 7);
      const yNorm = mix(region.y0, region.y1, (yi + 0.5) / 5);
      const viewDir = cameraDirection(xNorm * (width - 1), yNorm * (height - 1), width, height, params.horizonHeight);
      const color = skyRadiance(viewDir, sunDir, yNorm, params);
      r += color[0];
      g += color[1];
      b += color[2];
      count++;
    }
  }

  return rgbToFeatures([r / count, g / count, b / count]);
}

function buildModelSignature(params) {
  const bands = buildGradientBands();
  const bandSamples = bands.map((band) => ({
    t: band.t,
    features: sampleModelColor(params, regionAround({ x: 0.5, y: band.y }, 0.56, band.height))
  }));
  return buildSignatureFromBands(bandSamples);
}

function scoreModel(photo, model) {
  let score = 0;
  let totalWeight = 0;

  photo.bands.forEach((photoBand) => {
    let best = null;
    let bestDist = Infinity;
    model.bands.forEach((modelBand) => {
      const dist = Math.abs(modelBand.t - photoBand.t);
      if (dist < bestDist) {
        bestDist = dist;
        best = modelBand;
      }
    });
    if (!best) return;
    const weight = mix(0.85, 1.6, photoBand.t);
    score += colorDistance(photoBand.features, best.features) * weight;
    totalWeight += weight;
  });

  score /= Math.max(0.001, totalWeight);
  score += Math.abs(Math.log(photo.redBlue) - Math.log(model.redBlue)) * 0.18;
  score += Math.abs(photo.warmthGradient - model.warmthGradient) * 0.42;
  score += Math.abs(photo.brightnessGradient - model.brightnessGradient) * 0.18;
  return score;
}

function aboveHorizonFraction() {
  return photoState.horizonY - photoState.guides.sunDisk.y;
}

function rawGuidedElevationDegrees() {
  const fov = photoState.verticalFovDegrees || 32;
  return aboveHorizonFraction() * fov;
}

function guidedSunElevation() {
  const raw = rawGuidedElevationDegrees();
  const adjusted = raw - 1.5;
  // The -1.5 deg term is an empirical refraction/placement correction, tuned to improve
  // *fine* accuracy. It must never be allowed to flip which side of the horizon the sun
  // is on -- the marker positions are a direct visual read of that, not a soft hint.
  const elevation = raw >= 0 ? Math.max(adjusted, 0) : Math.min(adjusted, 0);
  return clamp(elevation, -7.5, 7.5);
}

// Keeps the guide marker as a soft tie-breaker rather than letting it override a clearly
// better color fit: the marker's pixel-to-degree mapping is only a rough geometric guess.
const ELEVATION_PENALTY_WEIGHT = 0.02;

function refineAtmosphereParams(baseParams, photoSignature, penalty = 0) {
  let current = { ...baseParams };
  let currentScore = scoreModel(photoSignature, buildModelSignature(current)) + penalty;
  let stepAod = 0.12;
  let stepRadius = 0.12;
  let iterations = 0;

  while (iterations < 30 && (stepAod > 0.008 || stepRadius > 0.008)) {
    iterations++;
    let improved = false;

    [
      ["aerosolDensity", stepAod, 0.05, 1.35],
      ["particleSize", stepRadius, 0.05, 1.2]
    ].forEach(([key, step, min, max]) => {
      [1, -1].forEach((sign) => {
        const candidate = { ...current, [key]: clamp(current[key] + step * sign, min, max) };
        const candidateScore = scoreModel(photoSignature, buildModelSignature(candidate)) + penalty;
        if (candidateScore < currentScore) {
          current = candidate;
          currentScore = candidateScore;
          improved = true;
        }
      });
    });

    if (!improved) {
      stepAod /= 2;
      stepRadius /= 2;
    }
  }

  return { params: current, score: currentScore };
}

// The guide marker directly encodes whether the sun sits above or below the horizon in the
// photo -- that's not a soft hint, it's close to ground truth. A color-only score can still
// find a "better fitting" but physically implausible elevation on the wrong side of that
// line (real photos are noisier than clean renders), so candidates too far from the guide
// are excluded outright rather than merely discouraged by a penalty.
const ELEVATION_SEARCH_RADIUS = 3.5;

function estimateAtmosphere(photoSignature) {
  const expectedElevation = guidedSunElevation();
  // A couple of pixels of marker-placement slop is the only real ambiguity here; the sign
  // of the raw pixel gap is otherwise a direct visual read of which side of the horizon the
  // sun is on, independent of whatever FOV happens to convert it to degrees.
  const aboveHorizonGap = aboveHorizonFraction();
  const elevations = Array.from(new Set([
    -7.5,
    -6,
    -2.5,
    -1,
    0,
    1.5,
    3,
    5,
    7.5,
    Number(expectedElevation.toFixed(1)),
    Number(clamp(expectedElevation - 1.2, -7.5, 7.5).toFixed(1)),
    Number(clamp(expectedElevation + 1.2, -7.5, 7.5).toFixed(1))
  ]))
    .filter((elevation) => Math.abs(elevation - expectedElevation) <= ELEVATION_SEARCH_RADIUS)
    // Hard guard, independent of the offset/radius above: a marker placement that
    // unambiguously shows the sun above (or below) the horizon must never be overridden
    // by a candidate on the opposite side, no matter how good its color score looks.
    .filter((elevation) => {
      if (aboveHorizonGap > 0.01) return elevation >= -0.5;
      if (aboveHorizonGap < -0.01) return elevation <= 0.5;
      return true;
    })
    .sort((a, b) => a - b);
  const aods = [0.06, 0.15, 0.28, 0.46, 0.72, 1.1];
  const radii = [0.06, 0.14, 0.26, 0.42, 0.65, 0.95];
  const matches = [];
  const guideAzimuth = (photoState.guides.sunDisk.x - 0.5) * 36;
  const modelHorizon = clamp(photoState.horizonY, 0.54, 0.78);

  elevations.forEach((sunElevation) => {
    aods.forEach((aerosolDensity) => {
      radii.forEach((particleSize) => {
        const params = {
          sunElevation,
          sunAzimuth: guideAzimuth,
          aerosolDensity,
          particleSize,
          horizonHeight: modelHorizon,
          horizonScene: controls.horizonScene.value,
          exposure: 1.05,
          ozoneAbsorption: controls.ozoneAbsorption.checked
        };
        const modelSignature = buildModelSignature(params);
        const positionPenalty = Math.abs(sunElevation - expectedElevation) * ELEVATION_PENALTY_WEIGHT;
        matches.push({ params, score: scoreModel(photoSignature, modelSignature) + positionPenalty });
      });
    });
  });

  matches.sort((a, b) => a.score - b.score);
  const nearby = matches.slice(1, 8).reduce((sum, item) => sum + item.score, 0) / 7;

  // Refine the best candidate per elevation (not just the raw top-3) so a coarse aod/radius
  // grid point doesn't crowd out a better-fitting elevation before refinement gets a chance.
  const bestPerElevation = new Map();
  matches.forEach((match) => {
    const key = match.params.sunElevation;
    if (!bestPerElevation.has(key) || match.score < bestPerElevation.get(key).score) {
      bestPerElevation.set(key, match);
    }
  });
  const topElevationCandidates = Array.from(bestPerElevation.values())
    .sort((a, b) => a.score - b.score)
    .slice(0, 5);

  const refinedTop = topElevationCandidates.map((match) => {
    const penalty = Math.abs(match.params.sunElevation - expectedElevation) * ELEVATION_PENALTY_WEIGHT;
    const refined = refineAtmosphereParams(match.params, photoSignature, penalty);
    return refined.score < match.score ? { params: refined.params, score: refined.score } : match;
  });
  refinedTop.sort((a, b) => a.score - b.score);

  const best = refinedTop[0];
  const separation = clamp((nearby - best.score) / Math.max(0.001, nearby), 0, 1);
  const confidence = clamp(0.28 + separation * 1.7 - best.score * 0.22, 0.08, 0.92);
  const candidates = refinedTop.slice(0, 3).map((match, index) => ({
    ...match,
    confidence: clamp(confidence - index * 0.08 - (match.score - best.score) * 0.18, 0.06, 0.92)
  }));
  return { ...best, confidence, candidates };
}

function drawPreviewPlaceholder() {
  const gradient = photoPreviewCtx.createLinearGradient(0, 0, 0, photoPreview.height);
  gradient.addColorStop(0, "#bfd6de");
  gradient.addColorStop(0.58, "#e5a465");
  gradient.addColorStop(1, "#211714");
  photoPreviewCtx.fillStyle = gradient;
  photoPreviewCtx.fillRect(0, 0, photoPreview.width, photoPreview.height);
}

function guideToCanvas(point) {
  const draw = photoState.draw;
  return {
    x: draw.x + point.x * draw.width,
    y: draw.y + point.y * draw.height
  };
}

function canvasToGuide(x, y) {
  const draw = photoState.draw;
  return {
    x: clamp((x - draw.x) / Math.max(1, draw.width), 0.04, 0.96),
    y: clamp((y - draw.y) / Math.max(1, draw.height), 0.04, 0.96)
  };
}

function drawPhotoBase() {
  if (!photoState.imageData) {
    drawPreviewPlaceholder();
    return;
  }
  photoPreviewCtx.putImageData(photoState.imageData, 0, 0);
}

function drawGuideRegion(point, width, height, color) {
  const uiScale = photoPreview.width / 320;
  const draw = photoState.draw;
  const x = draw.x + (point.x - width / 2) * draw.width;
  const y = draw.y + (point.y - height / 2) * draw.height;
  photoPreviewCtx.strokeStyle = color;
  photoPreviewCtx.lineWidth = 1.5 * uiScale;
  photoPreviewCtx.setLineDash([4 * uiScale, 3 * uiScale]);
  photoPreviewCtx.strokeRect(x, y, width * draw.width, height * draw.height);
  photoPreviewCtx.setLineDash([]);
}

function drawPhotoGuides() {
  if (!photoState.loaded) return;
  drawPhotoBase();
  const uiScale = photoPreview.width / 320;
  const colors = {
    upper: "#bfe9ff",
    sunDisk: "#fff4a6"
  };

  drawGuideRegion(photoState.guides.upper, 0.36, 0.18, colors.upper);

  const draw = photoState.draw;
  const horizonY = draw.y + photoState.horizonY * draw.height;
  photoPreviewCtx.strokeStyle = "#f8f1df";
  photoPreviewCtx.lineWidth = 2 * uiScale;
  photoPreviewCtx.beginPath();
  photoPreviewCtx.moveTo(draw.x, horizonY);
  photoPreviewCtx.lineTo(draw.x + draw.width, horizonY);
  photoPreviewCtx.stroke();
  photoPreviewCtx.fillStyle = "rgb(23 21 19 / 0.78)";
  photoPreviewCtx.fillRect(draw.x + 6 * uiScale, horizonY - 18 * uiScale, 74 * uiScale, 16 * uiScale);
  photoPreviewCtx.fillStyle = "#fff8e8";
  photoPreviewCtx.font = `${11 * uiScale}px system-ui, sans-serif`;
  photoPreviewCtx.fillText("Horizon", draw.x + 11 * uiScale, horizonY - 6 * uiScale);

  if (photoState.sunMask && photoState.sunMask.center) {
    const center = {
      x: photoState.sunMask.center.x * photoPreview.width,
      y: photoState.sunMask.center.y * photoPreview.height
    };
    const radius = photoState.sunMask.radius * Math.max(photoPreview.width, photoPreview.height);
    photoPreviewCtx.strokeStyle = "rgb(255 255 255 / 0.8)";
    photoPreviewCtx.lineWidth = 1.5 * uiScale;
    photoPreviewCtx.beginPath();
    photoPreviewCtx.arc(center.x, center.y, radius, 0, Math.PI * 2);
    photoPreviewCtx.stroke();
  }

  Object.entries(photoState.guides).forEach(([key, point]) => {
    const pos = guideToCanvas(point);
    photoPreviewCtx.fillStyle = colors[key];
    photoPreviewCtx.strokeStyle = "#171513";
    photoPreviewCtx.lineWidth = 2 * uiScale;
    photoPreviewCtx.beginPath();
    photoPreviewCtx.arc(pos.x, pos.y, 7 * uiScale, 0, Math.PI * 2);
    photoPreviewCtx.fill();
    photoPreviewCtx.stroke();
    photoPreviewCtx.fillStyle = "rgb(23 21 19 / 0.82)";
    const label = point.label;
    const textWidth = photoPreviewCtx.measureText(label).width;
    const labelOffsets = {
      upper: { x: 0, y: -24 },
      sunDisk: { x: 0, y: -30 }
    };
    const offset = labelOffsets[key] || { x: 0, y: -24 };
    const labelX = pos.x + offset.x * uiScale;
    const labelY = pos.y + offset.y * uiScale;
    photoPreviewCtx.fillRect(labelX - textWidth / 2 - 5 * uiScale, labelY, textWidth + 10 * uiScale, 15 * uiScale);
    photoPreviewCtx.fillStyle = "#fff8e8";
    photoPreviewCtx.fillText(label, labelX - textWidth / 2, labelY + 11 * uiScale);
  });
}

function rerunPhotoEstimate() {
  if (!photoState.loaded || !photoState.imageData) return;
  photoState.sunMask = sunMaskFromGuide(photoState.imageData);
  const signature = buildPhotoSignature(photoState.imageData);
  if (!signature) {
    updateEstimatePanel(null);
    inverseStatus.textContent = "Try another";
    drawPhotoGuides();
    return;
  }
  inverseStatus.textContent = "Searching";
  setTimeout(() => {
    updateEstimatePanel(estimateAtmosphere(signature));
    drawPhotoGuides();
  }, 20);
}

function formatCandidate(match, index) {
  const params = match.params;
  return `
    <button class="match-card ${index === selectedMatchIndex ? "active" : ""}" type="button" data-match-index="${index}">
      <strong>${index === 0 ? "Best" : `Option ${index + 1}`}</strong>
      <span>${(90 - params.sunElevation).toFixed(1)} deg zenith, AOD ${params.aerosolDensity.toFixed(2)}, r ${params.particleSize.toFixed(2)} um, horizon ${Math.round(params.horizonHeight * 100)}%</span>
    </button>
  `;
}

function selectedMatch() {
  if (!inverseEstimate) return null;
  const candidates = inverseEstimate.candidates || [inverseEstimate];
  return candidates[selectedMatchIndex] || candidates[0];
}

function refreshSelectedEstimate() {
  const match = selectedMatch();
  if (!match) return;
  const params = match.params;
  estimateZenith.textContent = `${(90 - params.sunElevation).toFixed(1)} deg`;
  estimateAod.textContent = params.aerosolDensity.toFixed(2);
  estimateRadius.textContent = `${params.particleSize.toFixed(2)} um`;
  estimateSunAngle.textContent = `${params.sunAzimuth.toFixed(0)} deg`;
  estimateHorizon.textContent = `${Math.round(params.horizonHeight * 100)}%`;
  estimateConfidence.textContent = `${Math.round(match.confidence * 100)}%`;
  matchList.innerHTML = (inverseEstimate.candidates || [inverseEstimate]).map(formatCandidate).join("");
}

function updateEstimatePanel(result) {
  inverseEstimate = result;
  selectedMatchIndex = 0;
  if (!result) {
    inverseStatus.textContent = "No photo";
    estimateZenith.textContent = "--";
    estimateAod.textContent = "--";
    estimateRadius.textContent = "--";
    estimateSunAngle.textContent = "--";
    estimateHorizon.textContent = "--";
    estimateConfidence.textContent = "--";
    matchList.innerHTML = "";
    applyEstimateButton.disabled = true;
    inverseNote.textContent = "Upload a sunset photo to retrieve the closest plausible model settings.";
    return;
  }

  inverseStatus.textContent = "Matched";
  refreshSelectedEstimate();
  applyEstimateButton.disabled = false;
  const calibrationNote = photoState.verticalFovDegrees
    ? ` Calibrated to this photo's field of view (${photoState.verticalFovDegrees.toFixed(0)} deg) from its EXIF focal length.`
    : "";
  inverseNote.textContent = `Drag Upper, Sun disk, and the Horizon line. Sun disk position guides zenith/angle; the horizon line controls the sampled warm sky band.${calibrationNote}`;
}

function activateTab(tabId) {
  tabButtons.forEach((button) => {
    const active = button.id === tabId;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });

  tabPanels.forEach((panel) => {
    const active = panel.getAttribute("aria-labelledby") === tabId;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

async function analyzeUploadedPhoto(file) {
  if (!file) return;
  inverseStatus.textContent = "Reading";
  applyEstimateButton.disabled = true;

  photoState.verticalFovDegrees = null;
  try {
    const buffer = await file.arrayBuffer();
    photoState.focalLength35mm = readExifFocalLength35mm(buffer);
  } catch (err) {
    photoState.focalLength35mm = null;
  }

  const image = new Image();
  image.onload = () => {
    const scale = Math.min(photoPreview.width / image.width, photoPreview.height / image.height);
    const drawW = image.width * scale;
    const drawH = image.height * scale;
    const drawX = (photoPreview.width - drawW) / 2;
    const drawY = (photoPreview.height - drawH) / 2;

    photoState.draw = { x: drawX, y: drawY, width: drawW, height: drawH };
    photoState.verticalFovDegrees = computeVerticalFovDegrees(photoState.focalLength35mm, image.width, image.height);
    photoPreviewCtx.fillStyle = "#14100d";
    photoPreviewCtx.fillRect(0, 0, photoPreview.width, photoPreview.height);
    photoPreviewCtx.drawImage(image, drawX, drawY, drawW, drawH);

    const imageData = photoPreviewCtx.getImageData(0, 0, photoPreview.width, photoPreview.height);
    photoState.loaded = true;
    photoState.imageData = imageData;
    photoState.horizonY = detectHorizonY(imageData);
    photoState.guides.upper = { x: 0.5, y: clamp(photoState.horizonY * 0.32, 0.12, 0.34), label: "Upper" };
    const autoSunMask = detectSunMask(imageData, (drawY + photoState.horizonY * drawH) / photoPreview.height);
    if (autoSunMask.center) {
      const guideCenter = canvasToGuide(
        autoSunMask.center.x * photoPreview.width,
        autoSunMask.center.y * photoPreview.height
      );
      photoState.guides.sunDisk = {
        x: clamp(guideCenter.x, 0.08, 0.92),
        y: clamp(guideCenter.y, 0.08, Math.max(0.12, photoState.horizonY - 0.02)),
        label: "Sun disk"
      };
    } else {
      photoState.guides.sunDisk = { x: 0.5, y: clamp(photoState.horizonY - 0.1, 0.18, 0.82), label: "Sun disk" };
    }
    photoState.sunMask = sunMaskFromGuide(imageData);
    const signature = buildPhotoSignature(imageData);
    if (!signature) {
      updateEstimatePanel(null);
      inverseStatus.textContent = "Try another";
      inverseNote.textContent = "The photo was too dark or clipped for the estimator to sample sky color reliably.";
      drawPhotoGuides();
      URL.revokeObjectURL(image.src);
      return;
    }

    inverseStatus.textContent = "Searching";
    setTimeout(() => {
      updateEstimatePanel(estimateAtmosphere(signature));
      activateTab("tabTools");
      drawPhotoGuides();
      URL.revokeObjectURL(image.src);
    }, 20);
  };
  image.onerror = () => {
    updateEstimatePanel(null);
    inverseStatus.textContent = "Unreadable";
    inverseNote.textContent = "The selected file could not be loaded as an image.";
  };
  image.src = URL.createObjectURL(file);
}

function updateTimeLapseReadouts(params) {
  const progress = sunsetProgress(params.sunElevation);
  const redBlue = estimateRedBlueIndex(params);
  const minutes = Math.round(progress * 36);
  timeLapseValue.textContent = `${Math.round(progress * 100)}%`;
  timelineFill.style.width = `${Math.round(progress * 100)}%`;
  redBlueReadout.textContent = `Red:blue ${redBlue.toFixed(2)}`;
  timeLapseStatus.textContent = timeLapse.playing
    ? `Time-lapse +${minutes} min`
    : progress > 0.96
      ? "Sun below horizon"
      : "Manual sky";
}

function updateLabels(params) {
  outputs.sunElevation.textContent = `${params.sunElevation.toFixed(1)} deg`;
  outputs.sunAzimuth.textContent = `${params.sunAzimuth.toFixed(0)} deg`;
  outputs.aerosolDensity.textContent = `AOD ${params.aerosolDensity.toFixed(2)}`;
  outputs.particleSize.textContent = `${params.particleSize.toFixed(2)} um`;
  outputs.horizonHeight.textContent = `${Math.round(params.horizonHeight * 100)}%`;
  outputs.exposure.textContent = `${params.exposure.toFixed(2)}x`;
  const sceneName = controls.horizonScene.selectedOptions[0].textContent.toLowerCase();
  renderTitle.textContent = `Sunset  theta_z = ${(90 - params.sunElevation).toFixed(1)} deg,  r=${params.particleSize.toFixed(2)} um,  AOD=${params.aerosolDensity.toFixed(2)},  ${sceneName}`;
  updateTimeLapseReadouts(params);
}

function cameraDirection(x, y, width, height, horizon) {
  const aspect = width / height;
  const ndcX = (x / (width - 1) - 0.5) * aspect;
  const ndcY = y / (height - 1);
  const elevation = mix(25, 0, ndcY / horizon) * Math.PI / 180;
  const azimuth = ndcX * 54 * Math.PI / 180;
  const ce = Math.cos(elevation);
  return normalize([
    Math.sin(azimuth) * ce,
    Math.sin(elevation),
    Math.cos(azimuth) * ce
  ]);
}

function directionToPixel(direction, width, height, horizon) {
  const aspect = width / height;
  const elevation = Math.asin(clamp(direction[1], -1, 1)) * 180 / Math.PI;
  const azimuth = Math.atan2(direction[0], direction[2]) * 180 / Math.PI;
  const ndcX = azimuth / 54 / aspect;
  const yNorm = ((25 - elevation) / 25) * horizon;
  return {
    x: (ndcX + 0.5) * (width - 1),
    y: yNorm * (height - 1),
    visible: yNorm >= 0 && yNorm <= horizon && ndcX >= -0.5 && ndcX <= 0.5
  };
}

function sunDirection(params) {
  const elevation = params.sunElevation * Math.PI / 180;
  const azimuth = params.sunAzimuth * Math.PI / 180;
  const ce = Math.cos(elevation);
  return normalize([
    Math.sin(azimuth) * ce,
    Math.sin(elevation),
    Math.cos(azimuth) * ce
  ]);
}

function skyRadiance(viewDir, sunDir, yNorm, params) {
  const mu = clamp(dot(viewDir, sunDir), -1, 1);
  const altitude = clamp(viewDir[1] * 0.5 + 0.5);
  const horizon = Math.exp(-Math.max(viewDir[1], -0.08) * 9);
  const sunLow = smoothstep(8, -3, params.sunElevation);
  const density = params.aerosolDensity;
  const particle = params.particleSize;

  const rayleighPhase = 0.75 * (1 + mu * mu);
  const g = clamp(0.58 + particle * 0.27, 0.45, 0.88);
  const miePhase = (1 - g * g) / Math.pow(1 + g * g - 2 * g * mu, 1.5);
  const airMass = 1 / Math.max(0.08, viewDir[1] + 0.11);
  const opticalDepth = Math.exp(-density * airMass * 0.18);

  // Civil/nautical twilight (sun below the horizon): ozone's Chappuis band eats the
  // red/orange out of the long slant path while Rayleigh scattering still supplies blue,
  // producing a pink-to-violet band that has nothing to do with the sunset glow itself.
  // It ramps in once the sun dips below the horizon and is strongest around -6 deg. Keyed
  // to the raw view-direction altitude (0 at the horizon, ~0.42 at the top of the frame)
  // rather than the compressed `altitude` blend variable above, which only spans a narrow
  // 0.5-0.71 range here and would otherwise wash the same tint across the whole sky.
  // Toggleable so the original warm-only sunset model stays available.
  const twilightDepth = params.ozoneAbsorption ? smoothstep(2, -6, params.sunElevation) : 0;
  const skyAltitude = clamp(viewDir[1] / 0.42);
  const duskZenith = [72, 63, 112];
  const duskBand = [173, 96, 132];

  let zenithColor = mixColor([112, 139, 169], [150, 121, 102], sunLow);
  zenithColor = mixColor(zenithColor, duskZenith, twilightDepth * smoothstep(0.15, 0.6, skyAltitude) * 0.9);
  const horizonColor = mixColor([244, 180, 93], [225, 136, 34], clamp(density * 0.75));
  const emberColor = [198, 72, 12];
  const baseT = smoothstep(0.04, 0.9, altitude);
  let color = mixColor(horizonColor, zenithColor, baseT);

  const duskBandShape = Math.exp(-Math.pow((skyAltitude - 0.22) / 0.16, 2));
  color = mixColor(color, duskBand, twilightDepth * duskBandShape * 0.6);

  const forwardGlow = clamp(miePhase * density * 0.028, 0, 0.9);
  const solarBloom = Math.exp((mu - 1) * 900) * (0.42 + density * 0.76);
  const horizonAmber = clamp(horizon * density * (0.18 + sunLow * 0.42), 0, 1);
  const extinction = clamp(1 - opticalDepth, 0, 1);

  color = mixColor(color, emberColor, horizonAmber * 0.52);
  color[0] += forwardGlow * 105 + solarBloom * 255 + rayleighPhase * 7 * opticalDepth;
  color[1] += forwardGlow * 54 + solarBloom * 220 + rayleighPhase * 13 * opticalDepth;
  color[2] += forwardGlow * 14 + solarBloom * 128 + rayleighPhase * 23 * opticalDepth;

  const band = Math.exp(-Math.pow((yNorm - params.horizonHeight + 0.02) * 19, 2));
  color[0] -= band * density * 78;
  color[1] -= band * density * 62;
  color[2] -= band * density * 45;

  // Global darkening as the sun sinks: after sunset the whole sky loses illumination,
  // fastest at the zenith while the horizon band keeps a residual glow, so the classic
  // bright-arch-over-dark-sky twilight look emerges instead of a uniformly lit sky.
  const duskT = smoothstep(0.5, -8, params.sunElevation);
  const duskDim = 1 - duskT * (0.5 + 0.32 * smoothstep(0.08, 0.5, skyAltitude));

  const contrast = 1 + density * 0.28 + particle * 0.12;
  return color.map((channel) => Math.pow(clamp((channel / 255) * params.exposure * duskDim * (1 - extinction * 0.18)), 1 / contrast) * 255);
}

function drawSun(data, width, height, params, sunDir) {
  const sunPixel = directionToPixel(sunDir, width, height, params.horizonHeight);
  if (!sunPixel.visible) return;

  const centerX = sunPixel.x;
  const centerY = sunPixel.y;
  const radius = Math.max(8, width * 0.0095 * (1 + params.particleSize * 0.18));
  const glowRadius = radius * (1.35 + params.aerosolDensity * 0.62);

  for (let y = Math.max(0, Math.floor(centerY - glowRadius)); y < Math.min(height, Math.ceil(centerY + glowRadius)); y++) {
    for (let x = Math.max(0, Math.floor(centerX - glowRadius)); x < Math.min(width, Math.ceil(centerX + glowRadius)); x++) {
      const distance = Math.hypot(x - centerX, y - centerY);
      if (distance > glowRadius) continue;
      const i = (y * width + x) * 4;
      const disk = smoothstep(radius + 1.5, radius - 1.5, distance);
      const glow = Math.pow(1 - distance / glowRadius, 3) * 0.1;
      const amount = clamp(disk + glow);
      data[i] = mix(data[i], mix(255, 255, disk * 0.42), amount);
      data[i + 1] = mix(data[i + 1], mix(243, 245, disk * 0.36), amount);
      data[i + 2] = mix(data[i + 2], mix(213, 220, disk * 0.28), amount);
    }
  }
}

function ridgeNoise(x, width, seed = 0) {
  const n = x / width;
  return (
    Math.sin(n * 11.7 + seed) * 0.5 +
    Math.sin(n * 26.2 + seed * 1.7) * 0.28 +
    Math.sin(n * 57.9 + seed * 0.6) * 0.12
  );
}

function setPixel(data, width, x, y, color) {
  const i = (y * width + x) * 4;
  data[i] = clamp(color[0], 0, 255);
  data[i + 1] = clamp(color[1], 0, 255);
  data[i + 2] = clamp(color[2], 0, 255);
  data[i + 3] = 255;
}

function drawPlainGround(data, width, height, horizonY) {
  for (let y = horizonY; y < height; y++) {
    const groundT = smoothstep(horizonY, height, y);
    const bounce = Math.exp(-(y - horizonY) / height * 5.5) * 0.32;
    const reflectedY = clamp(Math.floor(horizonY - (y - horizonY) * 0.4), 0, horizonY - 1);
    for (let x = 0; x < width; x++) {
      const ri = (reflectedY * width + x) * 4;
      setPixel(data, width, x, y, [
        mix(12, data[ri], bounce) * (1 - groundT * 0.45),
        mix(9, data[ri + 1], bounce) * (1 - groundT * 0.45),
        mix(8, data[ri + 2], bounce) * (1 - groundT * 0.45)
      ]);
    }
  }
}

function drawMountains(data, width, height, horizonY) {
  drawPlainGround(data, width, height, horizonY);
}

function drawBeach(data, width, height, horizonY, sunDir, params) {
  const sunPixel = directionToPixel(sunDir, width, height, params.horizonHeight);
  const shoreY = mix(horizonY + height * 0.16, height * 0.86, 0.55);
  const shoreBand = height * 0.025;

  for (let y = horizonY; y < height; y++) {
    const depth = clamp((y - horizonY) / Math.max(1, shoreY - horizonY));
    const sandDepth = clamp((y - shoreY) / Math.max(1, height - shoreY));
    const waterWeight = smoothstep(shoreY + shoreBand, shoreY - shoreBand, y);
    const foam = Math.exp(-Math.pow((y - shoreY) / 5, 2));
    const reflectedY = clamp(Math.floor(horizonY - (y - horizonY) * 0.55), 0, horizonY - 1);
    const wave = Math.sin(y * 0.22) * 0.5;

    for (let x = 0; x < width; x++) {
      const ri = (reflectedY * width + x) * 4;
      const glintX = sunPixel.visible ? Math.exp(-Math.pow((x - sunPixel.x) / (width * (0.035 + depth * 0.08)), 2)) : 0;
      const glintY = Math.exp(-depth * 3.2);
      const glint = glintX * glintY * (0.36 + params.aerosolDensity * 0.18);
      const darken = 0.58 - depth * 0.24 + (wave + Math.sin(y * 0.11 - x * 0.025) * 0.5) * 0.025;
      const waterColor = [
        data[ri] * darken + 18 + glint * 185,
        data[ri + 1] * (darken * 0.72) + 11 + glint * 123,
        data[ri + 2] * (darken * 0.62) + 8 + glint * 64
      ];

      const grain = ridgeNoise(x + y * 0.7, width, 8.1) * 5;
      const sandColor = [
        54 + sandDepth * 22 + foam * 58 + grain,
        38 + sandDepth * 16 + foam * 42 + grain * 0.6,
        26 + sandDepth * 9 + foam * 28 + grain * 0.4
      ];

      setPixel(data, width, x, y, mixColor(sandColor, waterColor, waterWeight));
    }
  }
}

function drawForest(data, width, height, horizonY) {
  drawPlainGround(data, width, height, horizonY);
}

function drawSilhouetteOverlay(ctx, width, height, params) {
  const horizonY = Math.floor(params.horizonHeight * (height - 1));
  const asset = silhouetteAssets[params.horizonScene];
  if (!asset || !asset.loaded) return;

  const placement = {
    forest: { height: 0.68, width: 0.33, left: 0.035, bottom: 0.025, threshold: 95, inkDivisor: 40, preserveGray: false, cropToInk: true },
    mountains: { height: 0.10, bottom: 0.0, threshold: 246, preserveGray: false, fillBelow: true },
    beach: { height: 0.29, bottom: 0.0, threshold: 118, preserveGray: false }
  }[params.horizonScene];

  const drawH = Math.round(height * placement.height);
  const drawW = Math.round(width * (placement.width || 1));
  const drawX = Math.round(width * (placement.left || 0));
  const drawY = Math.round(horizonY - drawH + height * placement.bottom);

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = drawW;
  maskCanvas.height = drawH;
  const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });

  if (placement.cropToInk) {
    const crop = getInkCrop(asset, placement.threshold, placement.cropMaxYFraction || 1, placement.inkDivisor || 72);
    maskCtx.drawImage(
      asset.image,
      crop.x,
      crop.y,
      crop.width,
      crop.height,
      0,
      0,
      drawW,
      drawH
    );
  } else {
    maskCtx.drawImage(asset.image, 0, 0, drawW, drawH);
  }

  const mask = maskCtx.getImageData(0, 0, drawW, drawH);
  const pixels = mask.data;
  // When the overlay's top is clipped by the canvas (drawY < 0), the readable region must
  // shrink by the clipped amount too -- otherwise rows past the mask's bottom would sample
  // undefined pixels, whose NaN luminance painted a solid black rectangle below the scene.
  const yOffset = Math.max(0, -drawY);
  const outHeight = Math.min(drawH - yOffset, height - Math.max(0, drawY));
  if (outHeight <= 0) return;
  const out = ctx.getImageData(drawX, Math.max(0, drawY), drawW, outHeight);
  const outPixels = out.data;
  const fillFromY = placement.fillBelow ? new Array(drawW).fill(drawH + 1) : null;
  const fillToBottomFromY = placement.fillBottomFrom ? new Array(drawW).fill(drawH + 1) : null;

  if (fillFromY) {
    for (let x = 0; x < drawW; x++) {
      for (let y = 0; y < drawH; y++) {
        const sourceIndex = (y * drawW + x) * 4;
        const r = pixels[sourceIndex];
        const g = pixels[sourceIndex + 1];
        const b = pixels[sourceIndex + 2];
        const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
        if (clamp((placement.threshold - luminance) / 118) > 0.02) {
          fillFromY[x] = y;
          break;
        }
      }
    }
  }

  if (fillToBottomFromY) {
    const bottomFillStart = drawH * placement.fillBottomFrom;
    for (let x = 0; x < drawW; x++) {
      for (let y = drawH - 1; y >= bottomFillStart; y--) {
        const sourceIndex = (y * drawW + x) * 4;
        const r = pixels[sourceIndex];
        const g = pixels[sourceIndex + 1];
        const b = pixels[sourceIndex + 2];
        const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
        if (clamp((placement.threshold - luminance) / 72) > 0.02) {
          fillToBottomFromY[x] = y;
          break;
        }
      }
    }
  }

  for (let y = 0; y < out.height; y++) {
    for (let x = 0; x < out.width; x++) {
      const sourceIndex = ((y + yOffset) * drawW + x) * 4;
      const targetIndex = (y * out.width + x) * 4;
      const r = pixels[sourceIndex];
      const g = pixels[sourceIndex + 1];
      const b = pixels[sourceIndex + 2];
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      const maskInk = clamp((placement.threshold - luminance) / (placement.inkDivisor || 72));
      const fillInk = fillFromY && y + yOffset >= fillFromY[x] ? 1 : 0;
      const bottomFillInk = fillToBottomFromY && y + yOffset >= fillToBottomFromY[x] ? 1 : 0;
      const ink = Math.max(maskInk, fillInk, bottomFillInk);
      if (ink <= 0.02) continue;

      const silhouetteLevel = placement.preserveGray ? Math.max(4, luminance * 0.2) : 3;
      const alpha = clamp(ink * 1.25);
      outPixels[targetIndex] = mix(outPixels[targetIndex], silhouetteLevel, alpha);
      outPixels[targetIndex + 1] = mix(outPixels[targetIndex + 1], silhouetteLevel, alpha);
      outPixels[targetIndex + 2] = mix(outPixels[targetIndex + 2], silhouetteLevel, alpha);
      outPixels[targetIndex + 3] = 255;
    }
  }

  ctx.putImageData(out, drawX, Math.max(0, drawY));
}

function getInkCrop(asset, threshold, maxYFraction = 1, inkDivisor = 72) {
  const cacheKey = `crop_${threshold}_${maxYFraction}_${inkDivisor}`;
  if (asset[cacheKey]) return asset[cacheKey];

  const sourceCanvas = document.createElement("canvas");
  sourceCanvas.width = asset.image.naturalWidth;
  sourceCanvas.height = asset.image.naturalHeight;
  const sourceCtx = sourceCanvas.getContext("2d", { willReadFrequently: true });
  sourceCtx.drawImage(asset.image, 0, 0);
  const source = sourceCtx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height).data;
  let minX = sourceCanvas.width;
  let minY = sourceCanvas.height;
  let maxX = 0;
  let maxY = 0;
  const scanHeight = Math.round(sourceCanvas.height * maxYFraction);

  for (let y = 0; y < scanHeight; y++) {
    for (let x = 0; x < sourceCanvas.width; x++) {
      const i = (y * sourceCanvas.width + x) * 4;
      const r = source[i];
      const g = source[i + 1];
      const b = source[i + 2];
      const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
      if (clamp((threshold - luminance) / inkDivisor) > 0.02) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }

  const padX = Math.round(sourceCanvas.width * 0.015);
  const padY = Math.round(sourceCanvas.height * 0.01);
  asset[cacheKey] = {
    x: Math.max(0, minX - padX),
    y: Math.max(0, minY - padY),
    width: Math.min(sourceCanvas.width, maxX + padX) - Math.max(0, minX - padX),
    height: Math.min(sourceCanvas.height, maxY + padY) - Math.max(0, minY - padY)
  };

  return asset[cacheKey];
}

let citySkylineCache = null;

function cityBuildingLayer(rand, width, height, layer) {
  const buildings = [];
  let x = Math.floor(width * (layer.startJitter * rand()));
  while (x < width) {
    const buildingWidth = Math.floor(width * (layer.minW + rand() * layer.varW));
    const tall = rand() < layer.tallChance;
    const buildingHeight = Math.floor(
      height * (tall ? layer.tallH + rand() * 0.12 : layer.baseH + rand() * 0.08) * layer.heightScale
    );
    const shapeRoll = rand();
    const shape = tall
      ? (shapeRoll < 0.3 ? "crown" : shapeRoll < 0.48 ? "dome" : shapeRoll < 0.68 ? "setback" : "flat")
      : (shapeRoll < 0.18 ? "setback" : "flat");
    buildings.push({
      x0: x,
      x1: Math.min(width, x + buildingWidth),
      h: buildingHeight,
      shape,
      spire: shape === "crown" || (tall && rand() < 0.4),
      windowPhase: Math.floor(rand() * 4),
      id: buildings.length
    });
    x += buildingWidth + Math.floor(width * rand() * layer.gap);
  }
  return buildings;
}

function citySkyline(width, height) {
  if (citySkylineCache && citySkylineCache.width === width && citySkylineCache.height === height) {
    return citySkylineCache;
  }

  // Deterministic LCG so the skyline is stable across renders and slider drags.
  let seed = 1234567;
  const rand = () => {
    seed = (seed * 48271) % 2147483647;
    return seed / 2147483647;
  };

  citySkylineCache = {
    width,
    height,
    // Back layer: taller, hazier towers peeking over the front row for depth.
    back: cityBuildingLayer(rand, width, height, {
      startJitter: 0.05, minW: 0.03, varW: 0.05, tallChance: 0.42,
      tallH: 0.18, baseH: 0.08, heightScale: 1.15, gap: 0.03
    }),
    front: cityBuildingLayer(rand, width, height, {
      startJitter: 0.01, minW: 0.025, varW: 0.055, tallChance: 0.22,
      tallH: 0.14, baseH: 0.05, heightScale: 1, gap: 0.006
    })
  };
  return citySkylineCache;
}

// Vertical inset of the roofline at horizontal position t (0..1 across the building),
// so towers read as domes, tapered crowns, or stepped setbacks instead of flat slabs.
function cityTopOffset(building, t) {
  if (building.shape === "dome") {
    const arc = 1 - Math.sqrt(Math.max(0, 1 - Math.pow(t * 2 - 1, 2)));
    return building.h * 0.3 * arc;
  }
  if (building.shape === "crown") {
    return building.h * 0.32 * Math.abs(t * 2 - 1);
  }
  if (building.shape === "setback") {
    return t < 0.18 || t > 0.82 ? building.h * 0.24 : 0;
  }
  return 0;
}

function drawCityLayer(data, width, horizonY, buildings, color, options) {
  buildings.forEach((building) => {
    const span = Math.max(1, building.x1 - building.x0 - 1);
    const baseTop = Math.max(0, horizonY - building.h);

    for (let x = building.x0; x < building.x1; x++) {
      const t = (x - building.x0) / span;
      const top = Math.min(horizonY, baseTop + Math.round(cityTopOffset(building, t)));
      for (let y = top; y < horizonY; y++) {
        // Punch-through window bands: skip pixels so the sky shows through the facade,
        // like a cut-paper skyline. Solid margins are kept near edges and the roofline.
        if (options.punchWindows && y > top + 5 && y < horizonY - 3) {
          const band = Math.floor((y - building.windowPhase) / 6);
          const col = Math.floor((x - building.x0) / 4);
          const hash = Math.abs(Math.sin(band * 91.7 + col * 47.3 + building.id * 13.1) * 43758.5453) % 1;
          const inBandRow = (y - building.windowPhase) % 6 < 2;
          const inColGap = (x - building.x0) % 4 === 3;
          if (inBandRow && !inColGap && hash < 0.5 && t > 0.08 && t < 0.92) continue;
        }
        setPixel(data, width, x, y, color);
      }
    }

    if (building.spire) {
      const spireX = Math.floor((building.x0 + building.x1) / 2);
      const spireTop = Math.max(0, baseTop - Math.floor(building.h * 0.45));
      for (let y = spireTop; y < baseTop + 2; y++) {
        setPixel(data, width, spireX, y, color);
      }
    }
  });
}

function drawCityDuskLights(data, width, horizonY, buildings, duskLights) {
  if (duskLights <= 0.02) return;
  buildings.forEach((building) => {
    const top = Math.max(0, horizonY - building.h);
    for (let wy = top + 6 + building.windowPhase; wy < horizonY - 3; wy += 6) {
      for (let wx = building.x0 + 2; wx < building.x1 - 1; wx += 4) {
        const hash = Math.abs(Math.sin(wx * 12.9898 + wy * 78.233) * 43758.5453) % 1;
        if (hash < 0.24 * duskLights) {
          const glow = 0.55 + hash * 1.5;
          setPixel(data, width, wx, wy, [225 * glow, 176 * glow, 92 * glow]);
          if (wx + 1 < building.x1 - 1) {
            setPixel(data, width, wx + 1, wy, [188 * glow, 140 * glow, 70 * glow]);
          }
        }
      }
    }
  });
}

function drawCity(data, width, height, horizonY, params) {
  drawPlainGround(data, width, height, horizonY);
  const { back, front } = citySkyline(width, height);
  // Window lights fade in as the sun drops, matching how a real skyline lights up at dusk.
  const duskLights = smoothstep(3, -2, params.sunElevation);

  drawCityLayer(data, width, horizonY, back, [30, 27, 36], { punchWindows: false });
  drawCityLayer(data, width, horizonY, front, [8, 8, 11], { punchWindows: true });
  drawCityDuskLights(data, width, horizonY, front, duskLights);
}

function drawForeground(data, width, height, params, sunDir) {
  const horizonY = Math.floor(params.horizonHeight * (height - 1));

  if (params.horizonScene === "mountains") {
    drawPlainGround(data, width, height, horizonY);
    drawMountains(data, width, height, horizonY);
  } else if (params.horizonScene === "beach") {
    drawBeach(data, width, height, horizonY, sunDir, params);
  } else if (params.horizonScene === "forest") {
    drawPlainGround(data, width, height, horizonY);
    drawForest(data, width, height, horizonY);
  } else if (params.horizonScene === "city") {
    drawCity(data, width, height, horizonY, params);
  } else {
    drawPlainGround(data, width, height, horizonY);
  }
}

function render() {
  const params = getParams();
  lastParamSignature = getParamSignature();
  updateLabels(params);

  const width = canvas.width;
  const height = canvas.height;
  const image = ctx.createImageData(width, height);
  const data = image.data;
  const sunDir = sunDirection(params);

  for (let y = 0; y < height; y++) {
    const yNorm = y / (height - 1);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (yNorm > params.horizonHeight) {
        data[i] = 10;
        data[i + 1] = 8;
        data[i + 2] = 7;
        data[i + 3] = 255;
        continue;
      }

      const viewDir = cameraDirection(x, y, width, height, params.horizonHeight);
      const color = skyRadiance(viewDir, sunDir, yNorm, params);
      data[i] = clamp(color[0], 0, 255);
      data[i + 1] = clamp(color[1], 0, 255);
      data[i + 2] = clamp(color[2], 0, 255);
      data[i + 3] = 255;
    }
  }

  drawSun(data, width, height, params, sunDir);
  drawForeground(data, width, height, params, sunDir);
  ctx.putImageData(image, 0, 0);
  drawSilhouetteOverlay(ctx, width, height, params);
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 0);
}

function setSunElevation(value) {
  sunElevationProgrammatic = true;
  controls.sunElevation.value = clamp(value, timeLapse.endElevation, timeLapse.startElevation).toFixed(1);
  sunElevationProgrammatic = false;
}

function stopTimeLapse() {
  timeLapse.playing = false;
  timeLapse.startTime = 0;
  if (timeLapse.rafId) cancelAnimationFrame(timeLapse.rafId);
  timeLapse.rafId = 0;
  playSunsetButton.textContent = "Play sunset";
  queueRender();
}

function animateSunset(now) {
  if (!timeLapse.playing) return;
  if (!timeLapse.startTime) {
    const currentProgress = sunsetProgress(Number(controls.sunElevation.value));
    timeLapse.startTime = now - currentProgress * timeLapse.duration;
  }

  const progress = clamp((now - timeLapse.startTime) / timeLapse.duration);
  const elevation = mix(timeLapse.startElevation, timeLapse.endElevation, progress);
  setSunElevation(elevation);
  queueRender();

  if (progress >= 1) {
    stopTimeLapse();
    return;
  }

  timeLapse.rafId = requestAnimationFrame(animateSunset);
}

function startTimeLapse() {
  if (Number(controls.sunElevation.value) <= timeLapse.endElevation + 0.1) {
    setSunElevation(timeLapse.startElevation);
  }
  timeLapse.playing = true;
  timeLapse.startTime = 0;
  playSunsetButton.textContent = "Pause";
  timeLapse.rafId = requestAnimationFrame(animateSunset);
}

function previewPointer(event) {
  const rect = photoPreview.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (photoPreview.width / rect.width),
    y: (event.clientY - rect.top) * (photoPreview.height / rect.height)
  };
}

function nearestGuide(x, y) {
  if (!photoState.loaded) return null;
  const draw = photoState.draw;
  const uiScale = photoPreview.width / 320;
  let best = null;
  let bestDistance = Infinity;
  Object.entries(photoState.guides).forEach(([key, point]) => {
    const pos = guideToCanvas(point);
    const distance = Math.hypot(x - pos.x, y - pos.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = key;
    }
  });

  if (bestDistance <= 28 * uiScale) return best;

  const horizonPixelY = draw.y + photoState.horizonY * draw.height;
  if (Math.abs(y - horizonPixelY) < 18 * uiScale && x >= draw.x && x <= draw.x + draw.width) {
    return "horizonLine";
  }

  return null;
}

let guideRerunTimer = 0;

function scheduleGuideEstimate() {
  clearTimeout(guideRerunTimer);
  inverseStatus.textContent = "Searching";
  guideRerunTimer = setTimeout(rerunPhotoEstimate, 180);
}

function moveGuide(target, x, y) {
  // The sun disk may sit below the horizon line: for twilight photos the sun has already
  // set, and dragging the marker under the line is how the user says so. The allowance
  // (~0.3 of the frame) covers the estimator's -7.5 deg floor at typical FOVs.
  if (target === "horizonLine") {
    const guide = canvasToGuide(x, y);
    photoState.horizonY = clamp(guide.y, 0.34, 0.92);
    photoState.guides.sunDisk.y = Math.min(photoState.guides.sunDisk.y, Math.min(photoState.horizonY + 0.3, 0.96));
    photoState.guides.upper.y = Math.min(photoState.guides.upper.y, photoState.horizonY - 0.12);
  } else if (photoState.guides[target]) {
    const guide = canvasToGuide(x, y);
    const maxY = target === "upper" ? photoState.horizonY - 0.12 : Math.min(photoState.horizonY + 0.3, 0.96);
    photoState.guides[target].x = guide.x;
    photoState.guides[target].y = clamp(guide.y, 0.06, Math.max(0.08, maxY));
  }

  if (target === "sunDisk" && photoState.imageData) {
    photoState.sunMask = sunMaskFromGuide(photoState.imageData);
  }

  drawPhotoGuides();
  scheduleGuideEstimate();
}

Object.values(controls).forEach((input) => {
  input.addEventListener("input", () => {
    if (input === controls.sunElevation && timeLapse.playing && !sunElevationProgrammatic) {
      stopTimeLapse();
    }
    queueRender();
  });
  input.addEventListener("change", queueRender);
});

tabButtons.forEach((button) => {
  button.addEventListener("click", () => activateTab(button.id));
});

photoPreview.addEventListener("pointerdown", (event) => {
  const point = previewPointer(event);
  draggedGuide = nearestGuide(point.x, point.y);
  if (!draggedGuide) return;
  photoPreview.setPointerCapture(event.pointerId);
  moveGuide(draggedGuide, point.x, point.y);
});

photoPreview.addEventListener("pointermove", (event) => {
  const point = previewPointer(event);
  const hoverTarget = nearestGuide(point.x, point.y);
  photoPreview.style.cursor = hoverTarget ? "grab" : "crosshair";
  if (!draggedGuide) return;
  photoPreview.style.cursor = "grabbing";
  moveGuide(draggedGuide, point.x, point.y);
});

photoPreview.addEventListener("pointerup", (event) => {
  if (draggedGuide) {
    photoPreview.releasePointerCapture(event.pointerId);
    draggedGuide = null;
    rerunPhotoEstimate();
  }
});

matchList.addEventListener("click", (event) => {
  const card = event.target.closest("[data-match-index]");
  if (!card) return;
  selectedMatchIndex = Number(card.dataset.matchIndex);
  refreshSelectedEstimate();
});

setInterval(() => {
  if (getParamSignature() !== lastParamSignature) {
    queueRender();
  }
}, 180);

document.getElementById("matchReference").addEventListener("click", () => {
  stopTimeLapse();
  controls.sunElevation.value = "1.7";
  controls.sunAzimuth.value = "0";
  controls.aerosolDensity.value = "0.5";
  controls.particleSize.value = "0.3";
  controls.horizonHeight.value = "0.70";
  controls.horizonScene.value = "mountains";
  controls.exposure.value = "1.05";
  queueRender();
});

playSunsetButton.addEventListener("click", () => {
  if (timeLapse.playing) {
    stopTimeLapse();
  } else {
    startTimeLapse();
  }
});

resetSunsetButton.addEventListener("click", () => {
  stopTimeLapse();
  setSunElevation(timeLapse.startElevation);
  queueRender();
});

photoUpload.addEventListener("change", () => {
  analyzeUploadedPhoto(photoUpload.files[0]);
});

applyEstimateButton.addEventListener("click", () => {
  if (!inverseEstimate) return;
  stopTimeLapse();
  const params = selectedMatch().params;
  controls.sunElevation.value = params.sunElevation.toFixed(1);
  controls.sunAzimuth.value = params.sunAzimuth.toFixed(0);
  controls.aerosolDensity.value = params.aerosolDensity.toFixed(2);
  controls.particleSize.value = params.particleSize.toFixed(2);
  controls.horizonHeight.value = params.horizonHeight.toFixed(2);
  // The estimator recovers atmosphere parameters only -- it knows nothing about the
  // scenery in the photo, so Apply must not override the user's chosen horizon scene.
  controls.exposure.value = "1.05";
  queueRender();
});

document.getElementById("downloadImage").addEventListener("click", () => {
  const link = document.createElement("a");
  link.download = "sunset-sky-render.png";
  link.href = canvas.toDataURL("image/png");
  link.click();
});

drawPreviewPlaceholder();
updateEstimatePanel(null);
render();
