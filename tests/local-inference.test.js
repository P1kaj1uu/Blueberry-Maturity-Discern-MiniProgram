const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const path = require('node:path')
const crypto = require('node:crypto')

function runtime() {
  const files = new Map()
  const realManifest = require('../miniprogram/utils/model-manifest')
  const manifest = Object.assign({}, realManifest, { parts: realManifest.parts.map(part => Object.assign({}, part, {
    read: async () => { state.loadCount++; return require(`../miniprogram/models/${part.name}/data`) }
  })) })
  const config = { confidence: .25, timeout: 2000 }
  const state = { platform: 'ios', loadCount: 0, runs: 0, destroyed: 0, stall: false, initStall: false }
  const output = new Float32Array([320, 64, 320, 192, 128, 64, 128, 64, .1, .9, .95, .1])
  const manager = {
    writeFile(o) { files.set(o.filePath, Buffer.from(o.data)); o.success() },
    appendFile(o) { files.set(o.filePath, Buffer.concat([files.get(o.filePath), Buffer.from(o.data)])); o.success() },
    unlink(o) { files.delete(o.filePath); o.success() },
    rename(o) { files.set(o.newPath, files.get(o.oldPath)); files.delete(o.oldPath); o.success() }
  }
  const wx = {
    env: { USER_DATA_PATH: 'wxfile://usr' },
    getDeviceInfo: () => ({ platform: state.platform }),
    getFileSystemManager: () => manager,
    getFileInfo(o) {
      const data = files.get(o.filePath)
      if (!data) { o.fail({}); return }
      o.success({ size: data.length, digest: crypto.createHash('md5').update(data).digest('hex') })
    },
    base64ToArrayBuffer(s) { const b = Buffer.from(s, 'base64'); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) },
    canvasToTempFilePath(o) { o.success({ tempFilePath: 'wxfile://tmp/normalized.jpg' }) },
    createInferenceSession(o) {
      assert.equal(o.precisionLevel, 4)
      assert.equal(o.allowQuantize, false)
      assert.ok(files.has(o.model))
      return {
        onLoad(cb) { if (!state.initStall) setImmediate(cb) }, onError() {},
        run(inputs) {
          state.runs++
          assert.deepEqual(Array.from(inputs.images.shape), [1, 3, 640, 640])
          assert.equal(inputs.images.data.byteLength, 3 * 640 * 640 * 4)
          if (state.stall) return new Promise(() => {})
          return Promise.resolve({ output0: { type: 'float32', shape: [1, 6, 2], data: output.buffer } })
        },
        destroy() { state.destroyed++ }
      }
    }
  }
  const canvas = {
    createImage() { return { width: 1000, height: 500, set src(_) { setImmediate(() => this.onload()) } } },
    getContext() { return { fillRect() {}, drawImage() {}, getImageData() { return { data: new Uint8Array(640 * 640 * 4).fill(128) } } } }
  }
  const page = { createSelectorQuery() { return { select() { return this }, fields() { return this }, exec(cb) { cb([{ node: canvas }]) } } } }
  const module = { exports: {} }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../miniprogram/utils/local-inference.js'), 'utf8'), {
    module, wx, Promise, ArrayBuffer, Float32Array, setTimeout, clearTimeout, console, Error,
    require(name) {
      if (name === './model-manifest') return manifest
      if (name === '../config') return config
      return require('../miniprogram/utils/' + name.slice(2))
    }
  })
  return { detect: progress => module.exports.detectLocally('/assets/blueberries.jpg', progress, page), state, files, config }
}

test('本地识别组装真实模型、校验缓存、释放会话并生成两类统计', async () => {
  const r = runtime()
  const result = await r.detect().promise
  assert.deepEqual(result.summary, { total: 2, mature: 1, immature: 1, mature_ratio: 50 })
  assert.equal(result.image.path, 'wxfile://tmp/normalized.jpg')
  assert.equal(r.state.loadCount, 12)
  assert.equal(r.state.destroyed, 1)
  await r.detect().promise
  assert.equal(r.state.loadCount, 12)
  assert.equal(r.state.destroyed, 2)
})

test('取消运行中的推理后可立即重试，迟到结果不阻塞队列', async () => {
  const r = runtime()
  await r.detect().promise
  r.state.stall = true
  let running
  const reached = new Promise(resolve => { running = resolve })
  const request = r.detect(info => { if (info.progress === 80) running() })
  const rejection = assert.rejects(request.promise, /取消/)
  await reached
  request.abort()
  await rejection
  r.state.stall = false
  const result = await r.detect().promise
  assert.equal(result.summary.total, 2)
  assert.equal(r.state.destroyed, 3)
})

test('初始化超时释放队列，更新环境后可重试', async () => {
  const r = runtime()
  await r.detect().promise
  r.config.timeout = 30
  r.state.initStall = true
  await assert.rejects(r.detect().promise, /用时较长/)
  r.state.initStall = false
  r.config.timeout = 2000
  assert.equal((await r.detect().promise).summary.total, 2)
})

test('模拟器清楚提示使用真机，且不加载模型或请求接口', async () => {
  const r = runtime()
  r.state.platform = 'devtools'
  await assert.rejects(r.detect().promise, /手机微信/)
  assert.equal(r.state.loadCount, 0)
})
