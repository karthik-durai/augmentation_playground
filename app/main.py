import tempfile
from pathlib import Path

import h5py
import nibabel as nib
import numpy as np
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent
TEMPLATES_DIR = BASE_DIR / "templates"
STATIC_DIR = BASE_DIR / "static"

app = FastAPI(title="Augmentation Playground")

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

templates = Jinja2Templates(directory=TEMPLATES_DIR)


@app.get("/", response_class=HTMLResponse)
async def index(request: Request) -> HTMLResponse:
    return templates.TemplateResponse("index.html", {"request": request})


def _pick_h5_volume(h5_file: h5py.File) -> np.ndarray:
    candidates = []

    def _visit(name: str, obj: h5py.Dataset) -> None:
        if not isinstance(obj, h5py.Dataset):
            return
        if obj.ndim not in (3, 4):
            return
        if not np.issubdtype(obj.dtype, np.number):
            return
        score = 0
        lowered = name.lower()
        if "image" in lowered:
            score += 3
        if "volume" in lowered or "data" in lowered:
            score += 2
        candidates.append((score, name, obj))

    h5_file.visititems(_visit)

    if not candidates:
        raise ValueError("No 3D or 4D numeric datasets found in H5 file.")

    candidates.sort(key=lambda item: (-item[0], item[1]))
    _, name, dataset = candidates[0]
    data = dataset[()]

    if data.ndim == 4:
        channel_axis = None
        for axis, size in enumerate(data.shape):
            if size <= 5:
                channel_axis = axis
                break
        if channel_axis is None:
            channel_axis = 0
        data = np.take(data, indices=0, axis=channel_axis)

    return np.asarray(data, dtype=np.float32)


@app.post("/api/convert-h5")
async def convert_h5(file: UploadFile = File(...)) -> Response:
    if not file.filename:
        raise HTTPException(status_code=400, detail="Missing filename.")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in {".h5", ".hdf5"}:
        raise HTTPException(status_code=400, detail="Only .h5 or .hdf5 supported.")

    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as temp:
        temp.write(await file.read())
        temp_path = Path(temp.name)

    try:
        with h5py.File(temp_path, "r") as h5_file:
            volume = _pick_h5_volume(h5_file)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Unable to parse H5 file: {exc}") from exc
    finally:
        temp_path.unlink(missing_ok=True)

    image = nib.Nifti1Image(volume, affine=np.eye(4))

    with tempfile.NamedTemporaryFile(suffix=".nii.gz", delete=False) as out_file:
        out_path = Path(out_file.name)

    try:
        nib.save(image, out_path)
        payload = out_path.read_bytes()
    finally:
        out_path.unlink(missing_ok=True)

    return Response(content=payload, media_type="application/gzip")
