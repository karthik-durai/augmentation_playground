import { Niivue, SLICE_TYPE } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const fileInput = document.getElementById("file-input");
const fileMeta = document.getElementById("file-meta");
const viewerStatus = document.getElementById("viewer-status");

const canvasSelected = document.getElementById("canvas-selected");
const previewImage = document.getElementById("preview-image");

const axisSelect = document.getElementById("axis-select");
const sliceRange = document.getElementById("slice-range");
const sliceValue = document.getElementById("slice-value");
const transformControls = document.getElementById("transform-controls");
const transformsConfig = window.TRANSFORMS_CONFIG || { spatial: [], intensity: [] };
const transformState = new Map();
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

renderTransforms();
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

function readNumberValue(input, fallback) {
  if (!input) return fallback;
  const value = Number.parseFloat(input.value);
  return Number.isFinite(value) ? value : fallback;
}

function currentTransforms() {
  const spatial = {};
  const intensity = {};

  transformState.forEach((entry, key) => {
    const payload = { enabled: !!entry.enabled?.checked };
    const params = entry.params || {};

    Object.entries(params).forEach(([paramKey, paramInfo]) => {
      if (!paramInfo.input) return;
      if (paramInfo.type === "rangePair") {
        const first = readNumberValue(paramInfo.input[0], paramInfo.defaultValue[0]);
        const second = readNumberValue(paramInfo.input[1], paramInfo.defaultValue[1]);
        payload[paramKey] = [first, second];
      } else if (paramInfo.type === "select") {
        payload[paramKey] = paramInfo.input.value;
      } else if (paramInfo.type === "number") {
        payload[paramKey] = readNumberValue(paramInfo.input, paramInfo.defaultValue);
      } else {
        payload[paramKey] = readNumberValue(paramInfo.input, paramInfo.defaultValue);
      }
    });

    if (entry.group === "intensity") {
      intensity[key] = payload;
    } else {
      spatial[key] = payload;
    }
  });

  return {
    ...spatial,
    intensity,
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

function registerInput(input, valueEl) {
  if (!input) return;
  input.addEventListener("change", requestPreview);
  if (input.type === "range" && valueEl) {
    input.addEventListener("input", (event) => {
      valueEl.textContent = event.target.value;
    });
  }
}

function buildTransformControl(group, transform) {
  const wrapper = document.createElement("label");
  wrapper.className = "transform-row";
  wrapper.dataset.name = transform.torchio || transform.name || transform.key;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = !!transform.enabledByDefault;
  wrapper.appendChild(checkbox);

  const title = document.createElement("span");
  title.textContent = transform.name || transform.key;
  wrapper.appendChild(title);

  const paramsMeta = document.createElement("span");
  paramsMeta.className = "transform-params";
  paramsMeta.textContent = "";
  wrapper.appendChild(paramsMeta);

  const inputsContainer = document.createElement("div");
  inputsContainer.className = "transform-inputs";
  wrapper.appendChild(inputsContainer);

  const paramsState = {};

  Object.entries(transform.params || {}).forEach(([paramKey, paramDef]) => {
    const paramLabel = document.createElement("label");
    paramLabel.textContent = paramDef.label || paramKey;

    let inputElement = null;
    let valueElement = null;

    if (paramDef.type === "select") {
      inputElement = document.createElement("select");
      (paramDef.options || []).forEach((option) => {
        const opt = document.createElement("option");
        opt.value = option;
        opt.textContent = option;
        if (option === paramDef.default) {
          opt.selected = true;
        }
        inputElement.appendChild(opt);
      });
    } else if (paramDef.type === "rangePair") {
      const first = document.createElement("input");
      first.type = "range";
      first.min = paramDef.min;
      first.max = paramDef.max;
      first.step = paramDef.step;
      first.value = paramDef.default?.[0] ?? paramDef.min;

      const second = document.createElement("input");
      second.type = "range";
      second.min = paramDef.min;
      second.max = paramDef.max;
      second.step = paramDef.step;
      second.value = paramDef.default?.[1] ?? paramDef.max;

      const values = document.createElement("span");
      values.className = "range-value";
      values.textContent = `${first.value}, ${second.value}`;

      const updatePairValue = () => {
        values.textContent = `${first.value}, ${second.value}`;
      };
      first.addEventListener("input", updatePairValue);
      second.addEventListener("input", updatePairValue);

      paramLabel.appendChild(first);
      paramLabel.appendChild(values);
      paramLabel.appendChild(second);
      inputsContainer.appendChild(paramLabel);

      paramsState[paramKey] = {
        type: "rangePair",
        input: [first, second],
        defaultValue: paramDef.default,
      };

      registerInput(first, values);
      registerInput(second, values);
      return;
    } else {
      inputElement = document.createElement("input");
      inputElement.type = paramDef.type === "number" ? "number" : "range";
      if (paramDef.min !== undefined) inputElement.min = paramDef.min;
      if (paramDef.max !== undefined) inputElement.max = paramDef.max;
      if (paramDef.step !== undefined) inputElement.step = paramDef.step;
      if (paramDef.default !== undefined) inputElement.value = paramDef.default;
    }

    if (inputElement) {
      if (paramDef.type === "range") {
        valueElement = document.createElement("span");
        valueElement.className = "range-value";
        valueElement.textContent = inputElement.value;
      }

      if (paramDef.editable === false) {
        inputElement.disabled = true;
      }

      paramLabel.appendChild(inputElement);
      if (valueElement) {
        paramLabel.appendChild(valueElement);
      }
      inputsContainer.appendChild(paramLabel);

      paramsState[paramKey] = {
        type: paramDef.type,
        input: inputElement,
        defaultValue: paramDef.default,
      };

      registerInput(inputElement, valueElement);
    }
  });

  transformState.set(transform.key, {
    group,
    enabled: checkbox,
    params: paramsState,
  });

  registerInput(checkbox, null);
  if (transform.enabledByDefault) {
    inputsContainer.style.display = "grid";
  }

  checkbox.addEventListener("change", () => {
    inputsContainer.style.display = checkbox.checked ? "grid" : "none";
  });

  return wrapper;
}

function renderTransforms() {
  if (!transformControls) return;
  transformControls.innerHTML = "";

  const spatialDetails = document.createElement("details");
  spatialDetails.className = "accordion";
  spatialDetails.open = true;
  const spatialSummary = document.createElement("summary");
  spatialSummary.textContent = "Spatial";
  const spatialBody = document.createElement("div");
  spatialBody.className = "accordion-body";
  (transformsConfig.spatial || []).forEach((transform) => {
    spatialBody.appendChild(buildTransformControl("spatial", transform));
  });
  spatialDetails.appendChild(spatialSummary);
  spatialDetails.appendChild(spatialBody);
  transformControls.appendChild(spatialDetails);

  const intensityDetails = document.createElement("details");
  intensityDetails.className = "accordion";
  intensityDetails.open = true;
  const intensitySummary = document.createElement("summary");
  intensitySummary.textContent = "Intensity";
  const intensityBody = document.createElement("div");
  intensityBody.className = "accordion-body";
  (transformsConfig.intensity || []).forEach((transform) => {
    intensityBody.appendChild(buildTransformControl("intensity", transform));
  });
  intensityDetails.appendChild(intensitySummary);
  intensityDetails.appendChild(intensityBody);
  transformControls.appendChild(intensityDetails);
}


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
