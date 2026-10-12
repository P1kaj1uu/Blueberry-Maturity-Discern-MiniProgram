"""执行真实 best.pt 推理，并验证上传、旋转、空检测及统计边界。"""
import base64
import io
import unittest
from pathlib import Path
from fastapi.testclient import TestClient
from PIL import Image
from server.app import app, decode_image, summarize, Detection

ROOT = Path(__file__).resolve().parents[1]

def image_bytes(image, format='JPEG', **kwargs):
    output = io.BytesIO()
    image.save(output, format=format, **kwargs)
    return output.getvalue()

class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.context = TestClient(app)
        cls.client = cls.context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.context.__exit__(None, None, None)

    def test_real_model_photo_detection(self):
        with (ROOT / 'miniprogram' / 'assets' / 'blueberries.jpg').open('rb') as photo:
            response = self.client.post('/api/detect', files={'file': ('blueberries.jpg', photo, 'image/jpeg')})
        self.assertEqual(response.status_code, 200, response.text[:500])
        data = response.json()
        summary = data['summary']
        self.assertGreater(summary['total'], 1, '样图应检测到多颗真实蓝莓')
        self.assertEqual(summary['total'], len(data['detections']))
        self.assertEqual(summary['total'], summary['mature'] + summary['immature'])
        self.assertEqual(summary['mature_ratio'], round(summary['mature'] / summary['total'] * 100, 1))
        width, height = data['image']['width'], data['image']['height']
        returned = Image.open(io.BytesIO(base64.b64decode(data['image']['base64'])))
        self.assertEqual(returned.size, (width, height))
        for index, detection in enumerate(data['detections'], 1):
            self.assertEqual(detection['id'], index)
            self.assertEqual(detection['label'], '成熟' if detection['class_id'] == 1 else '未成熟')
            x1, y1, x2, y2 = detection['box']
            self.assertTrue(0 <= x1 < x2 <= width)
            self.assertTrue(0 <= y1 < y2 <= height)
            self.assertTrue(0.25 <= detection['confidence'] <= 1)
        print('真实样图检测结果：', summary)

    def test_blank_image_and_no_division_by_zero(self):
        data = image_bytes(Image.new('RGB', (640, 480), 'white'))
        response = self.client.post('/api/detect', files={'file': ('blank.jpg', data)})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['summary'], {'total': 0, 'mature': 0, 'immature': 0, 'mature_ratio': 0.0})

    def test_reject_invalid_empty_unsupported_and_oversize_files(self):
        for data, status in [(b'not an image', 400), (b'', 400),
                             (image_bytes(Image.new('RGB', (10, 10)), 'GIF'), 415),
                             (b'x' * (15 * 1024 * 1024 + 1), 413)]:
            with self.subTest(status=status, bytes=len(data)):
                self.assertEqual(self.client.post('/api/detect', files={'file': ('photo.jpg', data)}).status_code, status)

    def test_invalid_confidence(self):
        for value in ['0', '1', 'nan', 'not-number']:
            response = self.client.post('/api/detect', files={'file': ('image.jpg', b'x')}, data={'confidence': value})
            self.assertEqual(response.status_code, 422)

    def test_exif_rotation_and_transparent_png(self):
        original = Image.new('RGB', (120, 80), 'red')
        exif = original.getexif()
        exif[274] = 6
        image = decode_image(image_bytes(original, exif=exif))
        self.assertEqual(image.size, (80, 120))
        rgba = Image.new('RGBA', (10, 10), (0, 0, 0, 0))
        self.assertEqual(decode_image(image_bytes(rgba, 'PNG')).getpixel((0, 0)), (255, 255, 255))

    def test_mixed_class_counts(self):
        detections = [Detection(id=i+1, class_id=int(status == 'mature'), status=status,
                      label='成熟' if status == 'mature' else '未成熟', confidence=.9,
                      box=[1, 2, 3, 4]) for i, status in enumerate(['mature', 'immature', 'mature'])]
        self.assertEqual(summarize(detections).model_dump(), {'total': 3, 'mature': 2, 'immature': 1, 'mature_ratio': 66.7})

    def test_health_model_classes(self):
        self.assertEqual(self.client.get('/health').json()['classes'], {'0': 'Immature', '1': 'Mature'})

if __name__ == '__main__':
    unittest.main(verbosity=2)
