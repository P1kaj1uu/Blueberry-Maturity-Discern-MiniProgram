"""Verify lossless packaging, ONNX/PyTorch agreement and real JS postprocessing."""
import base64
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
import torch
from ultralytics import YOLO
from ultralytics.utils.nms import non_max_suppression

ROOT = Path(__file__).resolve().parents[1]


def main():
    model_bytes = (ROOT / 'model/best.onnx').read_bytes()
    parts = sorted((ROOT / 'miniprogram/models').glob('*/data.js'))
    assembled = b''.join(base64.b64decode(json.loads(p.read_text().removeprefix('module.exports = ').strip())) for p in parts)
    assert assembled == model_bytes
    app = json.loads((ROOT / 'miniprogram/app.json').read_text())
    package_roots = [ROOT / 'miniprogram' / p['root'] for p in app['subPackages']]
    package_sizes = [sum(p.stat().st_size for p in root.rglob('*') if p.is_file()) for root in package_roots]
    assert max(package_sizes) < 2 * 1024 * 1024
    all_size = sum(p.stat().st_size for p in (ROOT / 'miniprogram').rglob('*') if p.is_file())
    main_size = all_size - sum(package_sizes)
    assert main_size < 2 * 1024 * 1024 and all_size < 20 * 1024 * 1024

    image = cv2.imread(str(ROOT / 'miniprogram/assets/blueberries.jpg'))
    h, w = image.shape[:2]
    scale = min(640 / w, 640 / h)
    rw, rh = round(w * scale), round(h * scale)
    left, top = round((640 - rw) / 2 - .1), round((640 - rh) / 2 - .1)
    canvas = np.full((640, 640, 3), 114, dtype=np.uint8)
    canvas[top:top + rh, left:left + rw] = cv2.resize(image, (rw, rh))
    tensor = np.ascontiguousarray(canvas[:, :, ::-1].transpose(2, 0, 1)[None], dtype=np.float32) / 255
    session = ort.InferenceSession(model_bytes, providers=['CPUExecutionProvider'])
    output = session.run(None, {'images': tensor})[0]
    model = YOLO(ROOT / 'model/best.pt').model.float().eval().fuse()
    with torch.no_grad():
        expected = model(torch.from_numpy(tensor))[0].numpy()
    assert output.shape == (1, 6, 8400)
    np.testing.assert_allclose(output, expected, rtol=1e-4, atol=2e-3)
    reference = non_max_suppression(torch.from_numpy(output.copy()), conf_thres=.25,
                                    iou_thres=.45, agnostic=True, max_det=1000)[0].numpy()
    transform = dict(width=w, height=h, scale=scale, left=left, top=top)
    with tempfile.TemporaryDirectory(prefix='berry-onnx-') as temp:
        raw = Path(temp) / 'output.bin'
        output.tofile(raw)
        code = "const fs=require('fs');const {decode}=require('./miniprogram/utils/yolo');const b=fs.readFileSync(process.argv[1]);const data=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);console.log(JSON.stringify(decode({type:'float32',shape:[1,6,8400],data},JSON.parse(process.argv[2]))))"
        result = json.loads(subprocess.check_output(['node', '-e', code, str(raw), json.dumps(transform)], cwd=ROOT))
    assert len(result['detections']) == len(reference), (result['summary'], len(reference))
    for item, expected_box in zip(result['detections'], reference):
        xyxy = expected_box[:4].copy()
        xyxy[[0, 2]] = np.clip((xyxy[[0, 2]] - left) / scale, 0, w)
        xyxy[[1, 3]] = np.clip((xyxy[[1, 3]] - top) / scale, 0, h)
        np.testing.assert_allclose(item['box'], xyxy, atol=.002)
        assert item['status'] == ('mature' if expected_box[5] == 1 else 'immature')
    fixture = {'shape': list(output.shape), 'values': output.reshape(-1).tolist()}
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    # A desktop inference fixture for UI-only tests; never packaged or used by production.
    (ROOT / 'artifacts/device-inference-fixture.json').write_text(json.dumps(fixture))
    report = {'model_md5': hashlib.md5(model_bytes).hexdigest(), 'model_bytes': len(model_bytes),
              'main_bytes': main_size, 'subpackage_max_bytes': max(package_sizes),
              'total_bytes': all_size, 'max_tensor_difference': float(np.max(np.abs(output - expected))),
              'summary': result['summary'], 'device_runtime_verified': False}
    (ROOT / 'artifacts/device-model-verification.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(report, ensure_ascii=False))


if __name__ == '__main__':
    main()
