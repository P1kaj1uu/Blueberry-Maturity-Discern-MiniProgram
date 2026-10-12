const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const { boxesForView } = require('../miniprogram/utils/detection')
const { absoluteImagePath } = require('../miniprogram/utils/assets')
const { letterbox, rgbaToTensor, decode } = require('../miniprogram/utils/yolo')
const result = {
  image: { width: 1000, height: 500 },
  detections: [
    { id: 1, status: 'mature', label: '成熟', confidence: .934, box: [100, 50, 300, 150] },
    { id: 2, status: 'immature', label: '未成熟', confidence: .82, box: [500, 100, 700, 400] }
  ], summary: { total: 2, mature: 1, immature: 1, mature_ratio: 50 }
}

test('坐标缩放与类别筛选保留原始编号', () => {
  const all = boxesForView(result, 'all')
  assert.equal(all[0].style, 'left:10%;top:10%;width:20%;height:20%;')
  assert.equal(all[0].confidenceLabel, 93)
  assert.deepEqual(boxesForView(result, 'immature').map(item => item.id), [2])
  assert.deepEqual(boxesForView({ image: result.image, detections: [] }, 'all'), [])
})

function loadPage(upload) {
  let definition
  const wx = {
    pageScrollTo() {}, showToast() {},
    getFileSystemManager() { return { writeFile(options) { options.success() } } },
    env: { USER_DATA_PATH: '/user' }
  }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/pages/index/index.js'), 'utf8'), {
    Page(value) { definition = value }, wx,
    require(name) {
      if (name.includes('/recognize')) return { recognizeImage: upload }
      if (name.includes('/assets')) return require('../miniprogram/utils/assets')
      if (name.includes('/records')) return { list: () => [], add: async () => {} }
      if (name.includes('/detection')) return { boxesForView }
      return { maxFileSize: 15 * 1024 * 1024 }
    }
  })
  return Object.assign(definition, { data: structuredClone(definition.data), setData(value) { Object.assign(this.data, value) } })
}

test('取消后忽略迟到的服务响应', async () => {
  let resolve
  let aborted = false
  const page = loadPage(() => ({ promise: new Promise(r => { resolve = r }), abort() { aborted = true } }))
  const request = page.startDetection('/photo.jpg')
  page.reset()
  resolve(structuredClone(result))
  await request
  assert.equal(aborted, true)
  assert.equal(page.data.stage, 'home')
  assert.equal(page.data.result, null)
})

test('服务失败保留照片，可重试', async () => {
  const page = loadPage(() => ({ promise: Promise.reject(new Error('无法连接')), abort() {} }))
  await page.startDetection('/photo.jpg')
  assert.equal(page.data.stage, 'error')
  assert.equal(page.data.imagePath, '/photo.jpg')
  assert.equal(page.data.error, '无法连接')
})

test('代码包图片补全根路径，保留微信临时文件路径', () => {
  assert.equal(absoluteImagePath('assets/blueberries.jpg'), '/assets/blueberries.jpg')
  for (const value of ['/assets/blueberries.jpg', 'wxfile://tmp/a.jpg', 'http://tmp/a.jpg']) {
    assert.equal(absoluteImagePath(value), value)
  }
})

test('RGBA 转 RGB/NCHW 且移除透明通道', () => {
  assert.deepEqual(Array.from(rgbaToTensor(new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]))), [1, 0, 0, 1, 0, 0])
})

test('检测坐标去除补边，跨类别去重且统计只计一次', () => {
  const transform = letterbox(1000, 500)
  assert.equal(transform.top, 160)
  const tensor = new Float32Array([
    320, 320, 64, // center x
    320, 320, 192, // center y
    128, 128, 64, // width
    128, 128, 64, // height
    .1, .85, .9, // immature
    .95, .1, .1 // mature
  ])
  const decoded = decode({ shape: [1, 6, 3], type: 'float32', data: tensor.buffer }, transform)
  assert.deepEqual(decoded.summary, { total: 2, mature: 1, immature: 1, mature_ratio: 50 })
  assert.deepEqual(decoded.detections[0].box, [400, 150, 600, 350])
  assert.equal(decoded.detections[1].status, 'immature')
  const empty = decode({ shape: [1, 6, 1], type: 'float32', data: new Float32Array(6).buffer }, transform)
  assert.equal(empty.summary.mature_ratio, 0)
  assert.throws(() => decode({ shape: [1, 7, 1], type: 'float32', data: new Float32Array(7).buffer }, transform), /格式/)
})
