import io
import random
import tempfile
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

app = FastAPI(title="Augmentation Playground")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=TEMPLATES_DIR)

_VOLUME_STORE: Dict[str, Dict[str, Any]] = {}


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

    flip = transforms_payload.get("flip")
    if isinstance(flip, dict) and flip.get("enabled"):
        transforms.append(
            {
                "name": "RandomFlip",
                "params": {
                    "axes": flip.get("axes", ("lr",)),
                    "p": float(flip.get("p", 0.5)),
                },
            }
        )

    affine = transforms_payload.get("affine")
    if isinstance(affine, dict) and affine.get("enabled"):
        transforms.append(
            {
                "name": "RandomAffine",
                "params": {
                    "scales": affine.get("scales", (0.9, 1.1)),
                    "degrees": affine.get("degrees", 10),
                    "translation": affine.get("translation", 5),
                },
            }
        )

    elastic = transforms_payload.get("elastic")
    if isinstance(elastic, dict) and elastic.get("enabled"):
        transforms.append(
            {
                "name": "RandomElasticDeformation",
                "params": {
                    "num_control_points": elastic.get("numControlPoints", 7),
                    "max_displacement": elastic.get("maxDisplacement", 7),
                },
            }
        )

    anisotropy = transforms_payload.get("anisotropy")
    if isinstance(anisotropy, dict) and anisotropy.get("enabled"):
        transforms.append(
            {
                "name": "RandomAnisotropy",
                "params": {
                    "axes": anisotropy.get("axes", (2,)),
                    "downsampling": anisotropy.get("downsampling", 2),
                },
            }
        )

    motion = transforms_payload.get("motion")
    if isinstance(motion, dict) and motion.get("enabled"):
        transforms.append(
            {
                "name": "RandomMotion",
                "params": {
                    "degrees": motion.get("degrees", 10),
                    "translation": motion.get("translation", 10),
                    "num_transforms": motion.get("numTransforms", 2),
                },
            }
        )

    ghosting = transforms_payload.get("ghosting")
    if isinstance(ghosting, dict) and ghosting.get("enabled"):
        transforms.append(
            {
                "name": "RandomGhosting",
                "params": {
                    "num_ghosts": ghosting.get("numGhosts", 4),
                    "intensity": ghosting.get("intensity", 0.5),
                },
            }
        )

    spike = transforms_payload.get("spike")
    if isinstance(spike, dict) and spike.get("enabled"):
        transforms.append(
            {
                "name": "RandomSpike",
                "params": {
                    "num_spikes": spike.get("numSpikes", 1),
                    "intensity": spike.get("intensity", 1.0),
                },
            }
        )

    swap = transforms_payload.get("swap")
    if isinstance(swap, dict) and swap.get("enabled"):
        transforms.append(
            {
                "name": "RandomSwap",
                "params": {
                    "patch_size": swap.get("patchSize", 15),
                    "num_iterations": swap.get("numIterations", 100),
                },
            }
        )

    intensity = transforms_payload.get("intensity")
    if isinstance(intensity, dict):
        noise = intensity.get("noise")
        if isinstance(noise, dict) and noise.get("enabled"):
            transforms.append(
                {
                    "name": "RandomNoise",
                    "params": {
                        "mean": float(noise.get("mean", 0.0)),
                        "std": float(noise.get("std", 0.1)),
                    },
                }
            )
        gamma = intensity.get("gamma")
        if isinstance(gamma, dict) and gamma.get("enabled"):
            transforms.append(
                {
                    "name": "RandomGamma",
                    "params": {
                        "log_gamma": gamma.get("logGamma", (-0.3, 0.3)),
                    },
                }
            )
        bias = intensity.get("bias")
        if isinstance(bias, dict) and bias.get("enabled"):
            transforms.append(
                {
                    "name": "RandomBiasField",
                    "params": {
                        "coefficients": bias.get("coefficients", 0.5),
                        "order": bias.get("order", 3),
                    },
                }
            )
        blur = intensity.get("blur")
        if isinstance(blur, dict) and blur.get("enabled"):
            transforms.append(
                {
                    "name": "RandomBlur",
                    "params": {
                        "std": blur.get("std", (0, 2)),
                    },
                }
            )

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


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


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

    transform_list = []

    flip = transforms_payload.get("flip")
    if isinstance(flip, dict) and flip.get("enabled"):
        transform_list.append(
            tio.RandomFlip(axes=flip.get("axes", ("lr",)), p=flip.get("p", 0.5))
        )

    affine = transforms_payload.get("affine")
    if isinstance(affine, dict) and affine.get("enabled"):
        transform_list.append(
            tio.RandomAffine(
                scales=affine.get("scales", (0.9, 1.1)),
                degrees=affine.get("degrees", 10),
                translation=affine.get("translation", 5),
            )
        )

    elastic = transforms_payload.get("elastic")
    if isinstance(elastic, dict) and elastic.get("enabled"):
        transform_list.append(
            tio.RandomElasticDeformation(
                num_control_points=elastic.get("numControlPoints", 7),
                max_displacement=elastic.get("maxDisplacement", 7),
            )
        )

    anisotropy = transforms_payload.get("anisotropy")
    if isinstance(anisotropy, dict) and anisotropy.get("enabled"):
        transform_list.append(
            tio.RandomAnisotropy(
                axes=anisotropy.get("axes", (2,)),
                downsampling=anisotropy.get("downsampling", 2),
            )
        )

    motion = transforms_payload.get("motion")
    if isinstance(motion, dict) and motion.get("enabled"):
        transform_list.append(
            tio.RandomMotion(
                degrees=motion.get("degrees", 10),
                translation=motion.get("translation", 10),
                num_transforms=motion.get("numTransforms", 2),
            )
        )

    ghosting = transforms_payload.get("ghosting")
    if isinstance(ghosting, dict) and ghosting.get("enabled"):
        transform_list.append(
            tio.RandomGhosting(
                num_ghosts=ghosting.get("numGhosts", 4),
                intensity=ghosting.get("intensity", 0.5),
            )
        )

    spike = transforms_payload.get("spike")
    if isinstance(spike, dict) and spike.get("enabled"):
        transform_list.append(
            tio.RandomSpike(
                num_spikes=spike.get("numSpikes", 1),
                intensity=spike.get("intensity", 1.0),
            )
        )

    swap = transforms_payload.get("swap")
    if isinstance(swap, dict) and swap.get("enabled"):
        transform_list.append(
            tio.RandomSwap(
                patch_size=swap.get("patchSize", 15),
                num_iterations=swap.get("numIterations", 100),
            )
        )

    intensity = transforms_payload.get("intensity")
    if isinstance(intensity, dict):
        noise = intensity.get("noise")
        if isinstance(noise, dict) and noise.get("enabled"):
            transform_list.append(
                tio.RandomNoise(mean=noise.get("mean", 0.0), std=noise.get("std", 0.1))
            )
        gamma = intensity.get("gamma")
        if isinstance(gamma, dict) and gamma.get("enabled"):
            transform_list.append(
                tio.RandomGamma(log_gamma=gamma.get("logGamma", (-0.3, 0.3)))
            )
        bias = intensity.get("bias")
        if isinstance(bias, dict) and bias.get("enabled"):
            transform_list.append(
                tio.RandomBiasField(
                    coefficients=bias.get("coefficients", 0.5), order=bias.get("order", 3)
                )
            )
        blur = intensity.get("blur")
        if isinstance(blur, dict) and blur.get("enabled"):
            transform_list.append(
                tio.RandomBlur(std=blur.get("std", (0, 2)))
            )

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
