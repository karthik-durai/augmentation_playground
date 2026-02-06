import io
import os
import random
import tempfile
import json
from pathlib import Path
from typing import Any, Dict
from uuid import uuid4

import nibabel as nib
import numpy as np
import torch
import torchio as tio
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from PIL import Image
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"
CONFIG_DIR = BASE_DIR / "config"
BIDS_ROOT = Path(os.getenv("BIDS_ROOT", "/data/bids"))
BIDS_HOST_PATH = os.getenv("BIDS_HOST_PATH", "")

app = FastAPI(title="Augmentation Playground")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=TEMPLATES_DIR)

_VOLUME_STORE: Dict[str, Dict[str, Any]] = {}


def _is_nifti_path(path: Path) -> bool:
    suffixes = "".join(path.suffixes).lower()
    return suffixes.endswith(".nii") or suffixes.endswith(".nii.gz")


def _resolve_bids_path(relative_path: str | None) -> Path:
    if not relative_path:
        relative_path = "."
    target = (BIDS_ROOT / relative_path).resolve()
    try:
        target.relative_to(BIDS_ROOT.resolve())
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Invalid BIDS path.") from exc
    return target


def _normalize_to_uint8(array: np.ndarray) -> np.ndarray:
    finite = array[np.isfinite(array)]
    if finite.size == 0:
        return np.zeros_like(array, dtype=np.uint8)
    vmin = float(finite.min())
    vmax = float(finite.max())
    if vmax <= vmin:
        return np.zeros_like(array, dtype=np.uint8)
    scaled = (array - vmin) / (vmax - vmin)
    scaled = np.clip(scaled, 0.0, 1.0)
    return (scaled * 255).astype(np.uint8)


def _slice_from_volume(volume: np.ndarray, axis: str, index: int) -> np.ndarray:
    axis = axis.lower()
    if axis == "sagittal":
        index = int(np.clip(index, 0, volume.shape[0] - 1))
        return volume[index, :, :]
    if axis == "coronal":
        index = int(np.clip(index, 0, volume.shape[1] - 1))
        return volume[:, index, :]
    index = int(np.clip(index, 0, volume.shape[2] - 1))
    return volume[:, :, index]


def _build_transform_config(transforms_payload: Dict[str, Any]) -> Dict[str, Any]:
    transforms: list[dict[str, Any]] = []

    order = transforms_payload.get("order", {})
    order_spatial = order.get(
        "spatial",
        ["flip", "affine", "elastic", "anisotropy", "motion", "ghosting", "spike", "swap"],
    )
    order_intensity = order.get("intensity", ["noise", "gamma", "bias", "blur"])

    def _append(name: str, params: Dict[str, Any]) -> None:
        transforms.append({"name": name, "params": params})

    for key in order_spatial:
        payload = transforms_payload.get(key)
        if not isinstance(payload, dict) or not payload.get("enabled"):
            continue
        if key == "flip":
            _append(
                "RandomFlip",
                {"axes": payload.get("axes", ("lr",)), "p": float(payload.get("p", 0.5))},
            )
        elif key == "affine":
            _append(
                "RandomAffine",
                {
                    "scales": payload.get("scales", (0.9, 1.1)),
                    "degrees": payload.get("degrees", 10),
                    "translation": payload.get("translation", 5),
                },
            )
        elif key == "elastic":
            _append(
                "RandomElasticDeformation",
                {
                    "num_control_points": payload.get("numControlPoints", 7),
                    "max_displacement": payload.get("maxDisplacement", 7),
                },
            )
        elif key == "anisotropy":
            _append(
                "RandomAnisotropy",
                {
                    "axes": payload.get("axes", (2,)),
                    "downsampling": payload.get("downsampling", 2),
                },
            )
        elif key == "motion":
            _append(
                "RandomMotion",
                {
                    "degrees": payload.get("degrees", 10),
                    "translation": payload.get("translation", 10),
                    "num_transforms": payload.get("numTransforms", 2),
                },
            )
        elif key == "ghosting":
            _append(
                "RandomGhosting",
                {
                    "num_ghosts": payload.get("numGhosts", 4),
                    "intensity": payload.get("intensity", 0.5),
                },
            )
        elif key == "spike":
            _append(
                "RandomSpike",
                {
                    "num_spikes": payload.get("numSpikes", 1),
                    "intensity": payload.get("intensity", 1.0),
                },
            )
        elif key == "swap":
            _append(
                "RandomSwap",
                {
                    "patch_size": payload.get("patchSize", 15),
                    "num_iterations": payload.get("numIterations", 100),
                },
            )

    intensity = transforms_payload.get("intensity", {})
    for key in order_intensity:
        payload = intensity.get(key)
        if not isinstance(payload, dict) or not payload.get("enabled"):
            continue
        if key == "noise":
            _append(
                "RandomNoise",
                {"mean": float(payload.get("mean", 0.0)), "std": float(payload.get("std", 0.1))},
            )
        elif key == "gamma":
            _append("RandomGamma", {"log_gamma": payload.get("logGamma", (-0.3, 0.3))})
        elif key == "bias":
            _append(
                "RandomBiasField",
                {
                    "coefficients": payload.get("coefficients", 0.5),
                    "order": payload.get("order", 3),
                },
            )
        elif key == "blur":
            _append("RandomBlur", {"std": payload.get("std", (0, 2))})

    return {"library": "torchio", "transforms": transforms}


def _build_torchio_snippet(config: Dict[str, Any]) -> str:
    lines = ["import torchio as tio", "", "transform = tio.Compose(["]
    for entry in config.get("transforms", []):
        name = entry["name"]
        params = entry.get("params", {})
        if params:
            args = ", ".join(f"{key}={repr(value)}" for key, value in params.items())
            lines.append(f"    tio.{name}({args}),")
        else:
            lines.append(f"    tio.{name}(),")
    lines.append("])")
    return "\n".join(lines)


def _build_transform_list(transforms_payload: Dict[str, Any]) -> list[tio.Transform]:
    order = transforms_payload.get("order", {})
    order_spatial = order.get(
        "spatial",
        ["flip", "affine", "elastic", "anisotropy", "motion", "ghosting", "spike", "swap"],
    )
    order_intensity = order.get("intensity", ["noise", "gamma", "bias", "blur"])

    transform_list: list[tio.Transform] = []

    for key in order_spatial:
        payload = transforms_payload.get(key)
        if not isinstance(payload, dict) or not payload.get("enabled"):
            continue
        if key == "flip":
            transform_list.append(
                tio.RandomFlip(axes=payload.get("axes", ("lr",)), p=payload.get("p", 0.5))
            )
        elif key == "affine":
            transform_list.append(
                tio.RandomAffine(
                    scales=payload.get("scales", (0.9, 1.1)),
                    degrees=payload.get("degrees", 10),
                    translation=payload.get("translation", 5),
                )
            )
        elif key == "elastic":
            transform_list.append(
                tio.RandomElasticDeformation(
                    num_control_points=payload.get("numControlPoints", 7),
                    max_displacement=payload.get("maxDisplacement", 7),
                )
            )
        elif key == "anisotropy":
            transform_list.append(
                tio.RandomAnisotropy(
                    axes=payload.get("axes", (2,)),
                    downsampling=payload.get("downsampling", 2),
                )
            )
        elif key == "motion":
            transform_list.append(
                tio.RandomMotion(
                    degrees=payload.get("degrees", 10),
                    translation=payload.get("translation", 10),
                    num_transforms=payload.get("numTransforms", 2),
                )
            )
        elif key == "ghosting":
            transform_list.append(
                tio.RandomGhosting(
                    num_ghosts=payload.get("numGhosts", 4),
                    intensity=payload.get("intensity", 0.5),
                )
            )
        elif key == "spike":
            transform_list.append(
                tio.RandomSpike(
                    num_spikes=payload.get("numSpikes", 1),
                    intensity=payload.get("intensity", 1.0),
                )
            )
        elif key == "swap":
            transform_list.append(
                tio.RandomSwap(
                    patch_size=payload.get("patchSize", 15),
                    num_iterations=payload.get("numIterations", 100),
                )
            )

    intensity = transforms_payload.get("intensity", {})
    for key in order_intensity:
        payload = intensity.get(key)
        if not isinstance(payload, dict) or not payload.get("enabled"):
            continue
        if key == "noise":
            transform_list.append(
                tio.RandomNoise(mean=payload.get("mean", 0.0), std=payload.get("std", 0.1))
            )
        elif key == "gamma":
            transform_list.append(
                tio.RandomGamma(log_gamma=payload.get("logGamma", (-0.3, 0.3)))
            )
        elif key == "bias":
            transform_list.append(
                tio.RandomBiasField(
                    coefficients=payload.get("coefficients", 0.5), order=payload.get("order", 3)
                )
            )
        elif key == "blur":
            transform_list.append(tio.RandomBlur(std=payload.get("std", (0, 2))))

    return transform_list


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    config_path = CONFIG_DIR / "transforms.json"
    if config_path.exists():
        transforms_config = json.loads(config_path.read_text())
    else:
        transforms_config = {"spatial": [], "intensity": []}
    return templates.TemplateResponse(
        "index.html",
        {
            "request": request,
            "transforms_config": transforms_config,
            "bids_root": str(BIDS_ROOT),
            "bids_host_path": BIDS_HOST_PATH,
        },
    )


@app.get("/api/bids/tree")
async def list_bids_tree(path: str | None = None) -> Dict[str, Any]:
    if not BIDS_ROOT.exists():
        raise HTTPException(status_code=404, detail="BIDS directory not found.")

    target = _resolve_bids_path(path)
    if not target.exists():
        raise HTTPException(status_code=404, detail="Path not found.")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory.")

    entries = []
    for entry in sorted(target.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if entry.name.startswith("."):
            continue
        if entry.is_dir():
            entries.append(
                {"name": entry.name, "type": "dir", "path": str(entry.relative_to(BIDS_ROOT))}
            )
        elif entry.is_file() and _is_nifti_path(entry):
            entries.append(
                {
                    "name": entry.name,
                    "type": "file",
                    "path": str(entry.relative_to(BIDS_ROOT)),
                    "size": entry.stat().st_size,
                }
            )

    return {
        "path": str(target.relative_to(BIDS_ROOT)) if target != BIDS_ROOT else "",
        "entries": entries,
    }


@app.get("/api/bids/file")
async def get_bids_file(path: str) -> Response:
    if not BIDS_ROOT.exists():
        raise HTTPException(status_code=404, detail="BIDS directory not found.")

    target = _resolve_bids_path(path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    if not _is_nifti_path(target):
        raise HTTPException(status_code=400, detail="Only .nii or .nii.gz supported.")

    return Response(content=target.read_bytes(), media_type="application/octet-stream")


@app.post("/api/bids/select")
async def select_bids_file(payload: Dict[str, Any]) -> Dict[str, Any]:
    if not BIDS_ROOT.exists():
        raise HTTPException(status_code=404, detail="BIDS directory not found.")

    relative_path = payload.get("path")
    if not relative_path:
        raise HTTPException(status_code=400, detail="Missing path.")

    target = _resolve_bids_path(relative_path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status_code=404, detail="File not found.")
    if not _is_nifti_path(target):
        raise HTTPException(status_code=400, detail="Only .nii or .nii.gz supported.")

    try:
        image = nib.load(str(target))
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to read NIfTI: {exc}") from exc

    volume = image.get_fdata(dtype=np.float32)
    if volume.ndim != 3:
        raise HTTPException(status_code=400, detail="Expected a 3D NIfTI volume.")
    volume_id = uuid4().hex
    _VOLUME_STORE[volume_id] = {"volume": volume}

    return {"volume_id": volume_id, "shape": volume.shape, "filename": target.name}

@app.post("/api/volume")
async def upload_volume(file: UploadFile) -> Dict[str, Any]:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".nii", ".gz"}:
        raise HTTPException(status_code=400, detail="Only .nii or .nii.gz supported.")

    data = await file.read()
    try:
        image = nib.Nifti1Image.from_bytes(data)
    except Exception:
        suffixes = "".join(Path(file.filename).suffixes) or ".nii.gz"
        with tempfile.NamedTemporaryFile(suffix=suffixes) as temp:
            temp.write(data)
            temp.flush()
            try:
                image = nib.load(temp.name)
            except Exception as exc:  # pragma: no cover - depends on file input
                raise HTTPException(
                    status_code=400, detail=f"Unable to read NIfTI: {exc}"
                ) from exc

    volume = image.get_fdata(dtype=np.float32)
    if volume.ndim != 3:
        raise HTTPException(status_code=400, detail="Expected a 3D NIfTI volume.")
    volume_id = uuid4().hex
    _VOLUME_STORE[volume_id] = {
        "volume": volume,
    }

    return {
        "volume_id": volume_id,
        "shape": volume.shape,
    }


@app.post("/api/preview")
async def preview_slice(payload: Dict[str, Any]) -> Response:
    volume_id = payload.get("volume_id")
    axis = payload.get("axis", "axial")
    index = payload.get("index", 0)
    transforms_payload = payload.get("transforms", {})
    seed = payload.get("seed")

    if not volume_id or volume_id not in _VOLUME_STORE:
        raise HTTPException(status_code=404, detail="Volume not found.")

    volume = _VOLUME_STORE[volume_id]["volume"]

    tensor = torch.from_numpy(volume).unsqueeze(0)
    subject = tio.Subject(image=tio.ScalarImage(tensor=tensor))

    transform_list = _build_transform_list(transforms_payload)

    if transform_list:
        if seed is not None:
            try:
                seed_value = int(seed)
            except (TypeError, ValueError):
                seed_value = None
            if seed_value is not None:
                random.seed(seed_value)
                np.random.seed(seed_value)
                torch.manual_seed(seed_value)
        composed = tio.Compose(transform_list)
        subject = composed(subject)

    transformed = subject["image"].data.squeeze(0).cpu().numpy()
    slice_2d = _slice_from_volume(transformed, axis, int(index))
    axis_lower = axis.lower()
    if axis_lower == "axial":
        slice_2d = np.rot90(slice_2d, k=3)
    elif axis_lower == "coronal":
        slice_2d = np.rot90(slice_2d, k=1)
    elif axis_lower == "sagittal":
        slice_2d = np.rot90(np.fliplr(slice_2d), k=-1)
    slice_uint8 = _normalize_to_uint8(slice_2d)

    image = Image.fromarray(slice_uint8)
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return Response(content=buffer.getvalue(), media_type="image/png")


@app.post("/api/export-config")
async def export_config(payload: Dict[str, Any]) -> Dict[str, Any]:
    transforms_payload = payload.get("transforms", {})
    config = _build_transform_config(transforms_payload)
    python_snippet = _build_torchio_snippet(config)
    return {
        "config": config,
        "python": python_snippet,
    }
