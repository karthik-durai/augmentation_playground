# Augmentation Playground

Local-only FastAPI app for staging 3D NIfTI MRI files in the browser.

## Development

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

Open `http://127.0.0.1:8000`.

## Docker (with reload)

```bash
docker build -t augmentation-playground .
set -a
source .env
set +a
docker run --rm -p 8000:8000 \
  --env-file .env \
  -v "$PWD/app:/app/app" \
  -v "$BIDS_HOST_PATH:/data/bids:ro" \
  augmentation-playground
```
