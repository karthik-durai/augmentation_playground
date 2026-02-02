# Augmentation Playground

Local-only FastAPI app for staging 3D NIfTI MRI files in the browser.
Supports BraTS-style H5 files by converting them to NIfTI on upload.

## Run

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000`.
