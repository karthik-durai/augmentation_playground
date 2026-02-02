import { Niivue, SLICE_TYPE } from "https://unpkg.com/@niivue/niivue@0.57.0/dist/index.js";

const fileInput = document.getElementById("file-input");
const fileMeta = document.getElementById("file-meta");
const viewerStatus = document.getElementById("viewer-status");

const canvasSelected = document.getElementById("canvas-selected");
const canvasPreview = document.getElementById("canvas-preview");

let nvSelected;
let nvPreview;

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

  if (canvasPreview) {
    nvPreview = new Niivue();
    nvPreview.opts.dragAndDropEnabled = false;
    await nvPreview.attachToCanvas(canvasPreview);
  }

  const tripleViewLayout = [
    { sliceType: SLICE_TYPE.AXIAL, position: [0, 0, 1 / 3, 1] },
    { sliceType: SLICE_TYPE.CORONAL, position: [1 / 3, 0, 1 / 3, 1] },
    { sliceType: SLICE_TYPE.SAGITTAL, position: [2 / 3, 0, 1 / 3, 1] },
  ];

  nvSelected.setCustomLayout(tripleViewLayout);
  nvSelected.setSliceType(SLICE_TYPE.MULTIPLANAR);

  if (nvPreview) {
    nvPreview.setCustomLayout(tripleViewLayout);
    nvPreview.setSliceType(SLICE_TYPE.MULTIPLANAR);
  }
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

    if (nvPreview) {
      const previewFile = new File([blob], name, { type: mimeType });
      await nvPreview.loadFromFile(previewFile);
      nvPreview.drawScene();
    }
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
