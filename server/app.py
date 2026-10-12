"""将 model/best.pt 的真实检测结果提供给微信小程序。"""
import asyncio
import base64
import io
import logging
import math
import os
import threading
import time
import warnings
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated, Literal

ROOT = Path(__file__).resolve().parents[1]
for key, folder in [('YOLO_CONFIG_DIR', 'ultralytics'), ('MPLCONFIGDIR', 'matplotlib')]:
    directory = ROOT / '.runtime' / folder
    directory.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault(key, str(directory))
os.environ.setdefault('YOLO_AUTOINSTALL', 'false')

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError
PIL_IMAGE_OPEN = Image.open
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from ultralytics import YOLO

MAX_BYTES = 15 * 1024 * 1024
MAX_PIXELS = 24_000_000
Image.MAX_IMAGE_PIXELS = MAX_PIXELS
CLASS_MAPPING = {'mature': ('mature', '成熟'), 'immature': ('immature', '未成熟')}
logger = logging.getLogger('blueberry')

class ImageInfo(BaseModel):
    width: int
    height: int
    base64: str

class Detection(BaseModel):
    id: int
    class_id: int
    status: Literal['mature', 'immature']
    label: str
    confidence: float
    box: list[float]

class Summary(BaseModel):
    total: int
    mature: int
    immature: int
    mature_ratio: float

class DetectionResponse(BaseModel):
    image: ImageInfo
    detections: list[Detection]
    summary: Summary
    inference_ms: int

def summarize(detections: list[Detection]) -> Summary:
    mature = sum(item.status == 'mature' for item in detections)
    immature = sum(item.status == 'immature' for item in detections)
    total = mature + immature
    return Summary(total=total, mature=mature, immature=immature,
                   mature_ratio=round(mature / total * 100, 1) if total else 0.0)

def decode_image(data: bytes) -> Image.Image:
    if not data:
        raise HTTPException(400, '照片为空，请重新选择')
    if len(data) > MAX_BYTES:
        raise HTTPException(413, '照片超过 15MB，请压缩后再试')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with PIL_IMAGE_OPEN(io.BytesIO(data)) as original:
                if original.format not in {'JPEG', 'PNG', 'WEBP'}:
                    raise HTTPException(415, '请上传 JPG、PNG 或 WebP 格式的照片')
                if original.width * original.height > MAX_PIXELS:
                    raise HTTPException(413, '照片分辨率过大，请缩小后再试')
                original.load()
                oriented = ImageOps.exif_transpose(original)
                if 'A' in oriented.getbands() or oriented.mode == 'P':
                    rgba = oriented.convert('RGBA')
                    image = Image.new('RGB', rgba.size, 'white')
                    image.paste(rgba, mask=rgba.getchannel('A'))
                else:
                    image = oriented.convert('RGB')
                image.thumbnail((2560, 2560), Image.Resampling.LANCZOS)
                return image
    except HTTPException:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise HTTPException(413, '照片分辨率过大，请缩小后再试') from None
    except (UnidentifiedImageError, OSError, ValueError):
        raise HTTPException(400, '无法读取这张照片，请重新拍摄或选择其他图片') from None

class BlueberryDetector:
    def __init__(self, model_path: Path):
        if not model_path.is_file():
            raise RuntimeError(f'找不到模型文件：{model_path}')
        self.model = YOLO(str(model_path), task='detect')
        names = self.model.names
        if self.model.task != 'detect' or {str(name).lower() for name in names.values()} != set(CLASS_MAPPING):
            raise RuntimeError(f'模型类别与蓝莓成熟度不匹配：{names}')
        self.lock = threading.Lock()
        self.device = os.environ.get('BLUEBERRY_DEVICE', 'cpu')

    def predict(self, image: Image.Image, confidence: float) -> DetectionResponse:
        started = time.perf_counter()
        with self.lock:
            result = self.model.predict(source=image, imgsz=640, conf=confidence,
                                        iou=0.45, agnostic_nms=True, max_det=1000,
                                        device=self.device, verbose=False, save=False)[0]
        detections = []
        rows = result.boxes.data.cpu().tolist() if result.boxes is not None else []
        rows.sort(key=lambda row: (row[1], row[0]))
        for row in rows:
            x1, y1, x2, y2, score, class_id = row[:6]
            if not all(math.isfinite(value) for value in row[:6]):
                continue
            status, label = CLASS_MAPPING[str(result.names[int(class_id)]).lower()]
            box = [max(0, min(image.width, x1)), max(0, min(image.height, y1)),
                   max(0, min(image.width, x2)), max(0, min(image.height, y2))]
            if box[2] <= box[0] or box[3] <= box[1]:
                continue
            detections.append(Detection(id=len(detections) + 1, class_id=int(class_id),
                                        status=status, label=label, confidence=round(score, 4),
                                        box=[round(value, 2) for value in box]))
        buffer = io.BytesIO()
        image.save(buffer, format='JPEG', quality=92)
        return DetectionResponse(image=ImageInfo(width=image.width, height=image.height,
                                  base64=base64.b64encode(buffer.getvalue()).decode('ascii')),
                                 detections=detections, summary=summarize(detections),
                                 inference_ms=round((time.perf_counter() - started) * 1000))

@asynccontextmanager
async def lifespan(app: FastAPI):
    model_path = Path(os.environ.get('BLUEBERRY_MODEL', str(ROOT / 'model' / 'best.pt')))
    app.state.detector = await run_in_threadpool(BlueberryDetector, model_path)
    app.state.inference_gate = asyncio.Semaphore(2)
    logger.info('蓝莓模型已加载，类别：%s', app.state.detector.model.names)
    yield
    app.state.detector = None

app = FastAPI(title='蓝莓成熟度识别', version='1.0.0', lifespan=lifespan)

@app.middleware('http')
async def limit_upload(request, call_next):
    length = request.headers.get('content-length')
    try:
        if length and int(length) > MAX_BYTES + 64 * 1024:
            return JSONResponse(status_code=413, content={'detail': '照片超过 15MB，请压缩后再试'})
    except ValueError:
        return JSONResponse(status_code=400, content={'detail': '无效的上传请求'})
    response = await call_next(request)
    response.headers['Cache-Control'] = 'no-store'
    return response

@app.get('/health')
def health():
    detector = getattr(app.state, 'detector', None)
    if detector is None:
        raise HTTPException(503, '识别服务正在准备中')
    return {'status': 'ok', 'model': 'best.pt', 'classes': detector.model.names}

@app.post('/api/detect', response_model=DetectionResponse)
async def detect(file: Annotated[UploadFile, File()],
                 confidence: Annotated[float, Form(ge=0.05, le=0.95)] = 0.25):
    try:
        data = await file.read(MAX_BYTES + 1)
        async with app.state.inference_gate:
            image = await run_in_threadpool(decode_image, data)
            try:
                return await run_in_threadpool(app.state.detector.predict, image, confidence)
            except HTTPException:
                raise
            except Exception:
                logger.exception('蓝莓模型推理失败')
                raise HTTPException(500, '识别暂时失败，请稍后再试') from None
    finally:
        await file.close()
