import { Niivue, SLICE_TYPE } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const fileInput = document.getElementById("file-input");
const fileMeta = document.getElementById("file-meta");
const viewerStatus = document.getElementById("viewer-status");

const canvasSelected = document.getElementById("canvas-selected");
const previewImage = document.getElementById("preview-image");

const axisSelect = document.getElementById("axis-select");
const sliceRange = document.getElementById("slice-range");
const sliceValue = document.getElementById("slice-value");
const flipEnabled = document.getElementById("flip-enabled");
const flipAxis = document.getElementById("flip-axis");
const flipP = document.getElementById("flip-p");
const affineEnabled = document.getElementById("affine-enabled");
const affineScaleMin = document.getElementById("affine-scale-min");
const affineScaleMax = document.getElementById("affine-scale-max");
const affineDegrees = document.getElementById("affine-degrees");
const affineTranslation = document.getElementById("affine-translation");
const noiseEnabled = document.getElementById("noise-enabled");
const noiseMean = document.getElementById("noise-mean");
const noiseStd = document.getElementById("noise-std");
const gammaEnabled = document.getElementById("gamma-enabled");
const gammaMin = document.getElementById("gamma-min");
const gammaMax = document.getElementById("gamma-max");
const biasEnabled = document.getElementById("bias-enabled");
const biasCoefficients = document.getElementById("bias-coefficients");
const biasOrder = document.getElementById("bias-order");
const blurEnabled = document.getElementById("blur-enabled");
const blurMin = document.getElementById("blur-min");
const blurMax = document.getElementById("blur-max");
const elasticEnabled = document.getElementById("elastic-enabled");
const elasticControlPoints = document.getElementById("elastic-control-points");
const elasticMaxDisplacement = document.getElementById("elastic-max-displacement");
const anisotropyEnabled = document.getElementById("anisotropy-enabled");
const anisotropyAxis = document.getElementById("anisotropy-axis");
const anisotropyDownsampling = document.getElementById("anisotropy-downsampling");
const motionEnabled = document.getElementById("motion-enabled");
const motionDegrees = document.getElementById("motion-degrees");
const motionTranslation = document.getElementById("motion-translation");
const motionNum = document.getElementById("motion-num");
const ghostingEnabled = document.getElementById("ghosting-enabled");
const ghostingNum = document.getElementById("ghosting-num");
const ghostingIntensity = document.getElementById("ghosting-intensity");
const spikeEnabled = document.getElementById("spike-enabled");
const spikeNum = document.getElementById("spike-num");
const spikeIntensity = document.getElementById("spike-intensity");
const swapEnabled = document.getElementById("swap-enabled");
const swapPatch = document.getElementById("swap-patch");
const swapIterations = document.getElementById("swap-iterations");
const exportConfigButton = document.getElementById("export-config");
const copyConfigButton = document.getElementById("copy-config");
const previewPlaceholder = document.getElementById("preview-placeholder");

let nvSelected;
let volumeId = null;
let volumeShape = null;
let lastSliceIndex = { sagittal: null, coronal: null, axial: null };
let previewSeed = Math.floor(Math.random() * 1e9);

async function initNiivue() {
  if (!canvasSelected) return;
  if (nvSelected) return;

  const gl = canvasSelected.getContext("webgl2");
  if (!gl) {
    if (viewerStatus) {
      viewerStatus.textContent = "WebGL2 is required for Niivue.";
    }
    return;
  }

  nvSelected = new Niivue({
    crosshairWidth: 0
  });
  nvSelected.opts.dragAndDropEnabled = false;
  await nvSelected.attachToCanvas(canvasSelected);

  nvSelected.setSliceType(SLICE_TYPE.AXIAL);
}

async function loadVolumeToAll(file) {
  if (!file) return;
  await initNiivue();
  if (!nvSelected) return;

  if (viewerStatus) {
    viewerStatus.textContent = "Loading volume...";
  }
  try {
    const buffer = await file.arrayBuffer();
    const mimeType = file.type || "application/octet-stream";
    const name = file.name || "volume.nii.gz";
    const blob = new Blob([buffer], { type: mimeType });

    const selectedFile = new File([blob], name, { type: mimeType });
    await nvSelected.loadFromFile(selectedFile);
    nvSelected.drawScene();
    if (volumeShape) {
      lastSliceIndex = {
        sagittal: Math.floor((volumeShape[0] - 1) / 2),
        coronal: Math.floor((volumeShape[1] - 1) / 2),
        axial: Math.floor((volumeShape[2] - 1) / 2),
      };
    }
    syncSelectedViewer();
    if (viewerStatus) {
      viewerStatus.textContent = "Volume loaded";
    }
  } catch (error) {
    console.error(error);
    if (viewerStatus) {
      viewerStatus.textContent = "Failed to load file.";
    }
  }
}

async function loadSelectedFile(file) {
  if (!file) return;

  await uploadVolume(file);
  await loadVolumeToAll(file);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size < 10 && unitIndex > 0 ? 1 : 0)} ${units[unitIndex]}`;
}

function updateSelection(file) {
  if (!file) {
    if (fileMeta) {
      fileMeta.textContent = "No file selected.";
    }
    if (viewerStatus) {
      viewerStatus.textContent = "Awaiting volume";
    }
    return;
  }

  const name = file.name || "Unknown file";
  const size = formatBytes(file.size);
  if (fileMeta) {
    fileMeta.textContent = `${name} • ${size}`;
  }
  if (viewerStatus) {
    viewerStatus.textContent = "Volume ready for Niivue";
  }
}

fileInput.addEventListener("change", (event) => {
  const [file] = event.target.files || [];
  updateSelection(file);
  loadSelectedFile(file);
});

initNiivue();

async function uploadVolume(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/volume", {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(detail || "Upload failed");
  }

  const payload = await response.json();
  volumeId = payload.volume_id;
  volumeShape = payload.shape;
  previewSeed = Math.floor(Math.random() * 1e9);
  updateSliceRange();
  requestPreview();
}

function updateSliceRange() {
  if (!volumeShape || !sliceRange) return;
  const axis = axisSelect?.value || "axial";
  const axisIndex = axis === "sagittal" ? 0 : axis === "coronal" ? 1 : 2;
  const maxIndex = Math.max(0, volumeShape[axisIndex] - 1);
  sliceRange.max = String(maxIndex);
  if (Number(sliceRange.value) > maxIndex) {
    sliceRange.value = String(Math.floor(maxIndex / 2));
  }
  if (sliceValue) {
    sliceValue.textContent = sliceRange.value;
  }
}

function syncSelectedViewer() {
  if (!nvSelected || !volumeShape) return;
  const axis = axisSelect?.value || "axial";
  const index = Number(sliceRange?.value || 0);
  const axisIndex = axis === "sagittal" ? 0 : axis === "coronal" ? 1 : 2;
  const maxIndex = Math.max(0, volumeShape[axisIndex] - 1);
  const viewerIndex =
    axis === "coronal" || axis === "sagittal" ? maxIndex - index : index;
  const sliceNorm = volumeShape[axisIndex] > 1 ? viewerIndex / (volumeShape[axisIndex] - 1) : 0.5;

  const targetSliceType =
    axis === "sagittal"
      ? SLICE_TYPE.SAGITTAL
      : axis === "coronal"
        ? SLICE_TYPE.CORONAL
        : SLICE_TYPE.AXIAL;

  const target = {
    sagittal: lastSliceIndex.sagittal ?? Math.floor((volumeShape[0] - 1) / 2),
    coronal: lastSliceIndex.coronal ?? Math.floor((volumeShape[1] - 1) / 2),
    axial: lastSliceIndex.axial ?? Math.floor((volumeShape[2] - 1) / 2),
  };
  target[axis] = viewerIndex;

  if (typeof nvSelected.setSliceFrac === "function") {
    nvSelected.setSliceType(targetSliceType);
    if (typeof nvSelected.setSliceMM === "function") {
      nvSelected.setSliceMM(false);
    }
    nvSelected.setSliceFrac(sliceNorm);
    nvSelected.drawScene();
    lastSliceIndex = target;
    return;
  }

  const current = nvSelected.scene?.crosshairPos;
  if (Array.isArray(current) && current.length >= 3 && typeof nvSelected.moveCrosshairInVox === "function") {
    nvSelected.setSliceType(targetSliceType);
    const currentVox = current.map((value, idx) => {
      if (value <= 1.5) {
        return Math.round(value * (volumeShape[idx] - 1));
      }
      return Math.round(value);
    });
    const delta = [
      target.sagittal - currentVox[0],
      target.coronal - currentVox[1],
      target.axial - currentVox[2],
    ];
    nvSelected.moveCrosshairInVox(delta[0], delta[1], delta[2]);
    nvSelected.drawScene();
    lastSliceIndex = target;
    return;
  }

  if (typeof nvSelected.moveCrosshairInVox === "function") {
    nvSelected.setSliceType(targetSliceType);
    const delta = [
      target.sagittal - (lastSliceIndex.sagittal ?? target.sagittal),
      target.coronal - (lastSliceIndex.coronal ?? target.coronal),
      target.axial - (lastSliceIndex.axial ?? target.axial),
    ];
    nvSelected.moveCrosshairInVox(delta[0], delta[1], delta[2]);
    nvSelected.drawScene();
    lastSliceIndex = target;
  }
}

function currentTransforms() {
  const readNumber = (input, fallback) => {
    if (!input) return fallback;
    const value = Number.parseFloat(input.value);
    return Number.isFinite(value) ? value : fallback;
  };

  return {
    flip: {
      enabled: !!flipEnabled?.checked,
      axes: [flipAxis?.value || "LR"],
      p: readNumber(flipP, 0.5),
    },
    affine: {
      enabled: !!affineEnabled?.checked,
      scales: [readNumber(affineScaleMin, 0.9), readNumber(affineScaleMax, 1.1)],
      degrees: readNumber(affineDegrees, 10),
      translation: readNumber(affineTranslation, 5),
    },
    elastic: {
      enabled: !!elasticEnabled?.checked,
      numControlPoints: readNumber(elasticControlPoints, 7),
      maxDisplacement: readNumber(elasticMaxDisplacement, 7),
    },
    anisotropy: {
      enabled: !!anisotropyEnabled?.checked,
      axes: [readNumber(anisotropyAxis, 2)],
      downsampling: readNumber(anisotropyDownsampling, 2),
    },
    motion: {
      enabled: !!motionEnabled?.checked,
      degrees: readNumber(motionDegrees, 10),
      translation: readNumber(motionTranslation, 10),
      numTransforms: readNumber(motionNum, 2),
    },
    ghosting: {
      enabled: !!ghostingEnabled?.checked,
      numGhosts: readNumber(ghostingNum, 4),
      intensity: readNumber(ghostingIntensity, 0.5),
    },
    spike: {
      enabled: !!spikeEnabled?.checked,
      numSpikes: readNumber(spikeNum, 1),
      intensity: readNumber(spikeIntensity, 1.0),
    },
    swap: {
      enabled: !!swapEnabled?.checked,
      patchSize: readNumber(swapPatch, 15),
      numIterations: readNumber(swapIterations, 100),
    },
    intensity: {
      noise: {
        enabled: !!noiseEnabled?.checked,
        mean: readNumber(noiseMean, 0.0),
        std: readNumber(noiseStd, 0.1),
      },
      gamma: {
        enabled: !!gammaEnabled?.checked,
        logGamma: [readNumber(gammaMin, -0.3), readNumber(gammaMax, 0.3)],
      },
      bias: {
        enabled: !!biasEnabled?.checked,
        coefficients: readNumber(biasCoefficients, 0.5),
        order: readNumber(biasOrder, 3),
      },
      blur: {
        enabled: !!blurEnabled?.checked,
        std: [readNumber(blurMin, 0), readNumber(blurMax, 2)],
      },
    },
  };
}

let previewInFlight = false;

async function requestPreview() {
  if (!volumeId || !previewImage) return;
  if (previewInFlight) return;
  previewInFlight = true;

  const axis = axisSelect?.value || "axial";
  const index = Number(sliceRange?.value || 0);

  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        volume_id: volumeId,
        axis,
        index,
        seed: previewSeed,
        transforms: currentTransforms(),
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const blob = await response.blob();
    previewImage.src = URL.createObjectURL(blob);
    previewImage.classList.remove("is-hidden");
    if (previewPlaceholder) {
      previewPlaceholder.classList.add("is-hidden");
    }
  } catch (error) {
    console.error(error);
    previewImage.classList.add("is-hidden");
    previewImage.removeAttribute("src");
    if (previewPlaceholder) {
      previewPlaceholder.classList.remove("is-hidden");
    }
  } finally {
    previewInFlight = false;
  }
}

axisSelect?.addEventListener("change", () => {
  updateSliceRange();
  syncSelectedViewer();
  requestPreview();
});

sliceRange?.addEventListener("input", () => {
  if (sliceValue) {
    sliceValue.textContent = sliceRange.value;
  }
  syncSelectedViewer();
  requestPreview();
});

[
  flipEnabled,
  flipAxis,
  flipP,
  affineEnabled,
  affineScaleMin,
  affineScaleMax,
  affineDegrees,
  affineTranslation,
  elasticEnabled,
  elasticControlPoints,
  elasticMaxDisplacement,
  anisotropyEnabled,
  anisotropyAxis,
  anisotropyDownsampling,
  motionEnabled,
  motionDegrees,
  motionTranslation,
  motionNum,
  ghostingEnabled,
  ghostingNum,
  ghostingIntensity,
  spikeEnabled,
  spikeNum,
  spikeIntensity,
  swapEnabled,
  swapPatch,
  swapIterations,
  noiseEnabled,
  noiseMean,
  noiseStd,
  gammaEnabled,
  gammaMin,
  gammaMax,
  biasEnabled,
  biasCoefficients,
  biasOrder,
  blurEnabled,
  blurMin,
  blurMax,
].forEach((input) => {
  input?.addEventListener("change", requestPreview);
  if (input?.type === "range") {
    input.addEventListener("input", (event) => {
      const target = event.target;
      const output = document.querySelector(`.range-value[data-for="${target.id}"]`);
      if (output) {
        output.textContent = target.value;
      }
    });
  }
});


exportConfigButton?.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/export-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transforms: currentTransforms(),
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    const blob = new Blob([JSON.stringify(payload, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "torchio-config.json";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  } catch (error) {
    console.error(error);
  }
});

copyConfigButton?.addEventListener("click", async () => {
  try {
    const response = await fetch("/api/export-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transforms: currentTransforms(),
      }),
    });

    if (!response.ok) {
      throw new Error(await response.text());
    }

    const payload = await response.json();
    const text = payload.python || JSON.stringify(payload.config, null, 2);

    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "absolute";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    copyConfigButton.textContent = "Copied";
    setTimeout(() => {
      copyConfigButton.textContent = "Copy config";
    }, 1200);
  } catch (error) {
    console.error(error);
  }
});
