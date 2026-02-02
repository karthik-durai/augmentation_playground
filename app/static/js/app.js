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
const affineEnabled = document.getElementById("affine-enabled");
const noiseEnabled = document.getElementById("noise-enabled");
const gammaEnabled = document.getElementById("gamma-enabled");
const biasEnabled = document.getElementById("bias-enabled");
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

  nvSelected = new Niivue();
  nvSelected.opts.dragAndDropEnabled = false;
  await nvSelected.attachToCanvas(canvasSelected);

  const tripleViewLayout = [
    { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 1, 1 / 3] },
    { sliceType: SLICE_TYPE.CORONAL, position: [0, 1 / 3, 1, 1 / 3] },
    { sliceType: SLICE_TYPE.SAGITTAL, position: [0, 2 / 3, 1, 1 / 3] },
  ];

  nvSelected.setCustomLayout(tripleViewLayout);
  nvSelected.setSliceType(SLICE_TYPE.MULTIPLANAR);
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
  const sliceNorm = volumeShape[axisIndex] > 1 ? index / (volumeShape[axisIndex] - 1) : 0.5;

  const target = {
    sagittal: lastSliceIndex.sagittal ?? Math.floor((volumeShape[0] - 1) / 2),
    coronal: lastSliceIndex.coronal ?? Math.floor((volumeShape[1] - 1) / 2),
    axial: lastSliceIndex.axial ?? Math.floor((volumeShape[2] - 1) / 2),
  };
  target[axis] = index;

  if (typeof nvSelected.setSliceFrac === "function") {
    const targetSliceType =
      axis === "sagittal"
        ? SLICE_TYPE.SAGITTAL
        : axis === "coronal"
          ? SLICE_TYPE.CORONAL
          : SLICE_TYPE.AXIAL;
    nvSelected.setSliceType(targetSliceType);
    if (typeof nvSelected.setSliceMM === "function") {
      nvSelected.setSliceMM(false);
    }
    nvSelected.setSliceFrac(sliceNorm);
    nvSelected.setSliceType(SLICE_TYPE.MULTIPLANAR);
    nvSelected.drawScene();
    lastSliceIndex = target;
    return;
  }

  const current = nvSelected.scene?.crosshairPos;
  if (Array.isArray(current) && current.length >= 3 && typeof nvSelected.moveCrosshairInVox === "function") {
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
  return {
    flip: {
      enabled: !!flipEnabled?.checked,
      axes: ["lr"],
      p: 0.5,
    },
    affine: {
      enabled: !!affineEnabled?.checked,
      scales: [0.9, 1.1],
      degrees: 10,
      translation: 5,
    },
    intensity: {
      noise: {
        enabled: !!noiseEnabled?.checked,
        mean: 0.0,
        std: 0.1,
      },
      gamma: {
        enabled: !!gammaEnabled?.checked,
        logGamma: [-0.3, 0.3],
      },
      bias: {
        enabled: !!biasEnabled?.checked,
        coefficients: 0.5,
        order: 3,
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

[flipEnabled, affineEnabled, noiseEnabled, gammaEnabled, biasEnabled].forEach((input) => {
  input?.addEventListener("change", requestPreview);
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
