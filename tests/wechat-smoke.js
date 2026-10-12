const automator = require('miniprogram-automator')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// 新版工具将自动化 SDK 标为 development，官方旧测试库只识别 dev。
const MiniProgram = require('miniprogram-automator/out/MiniProgram').default
const originalVersionCheck = MiniProgram.prototype.checkVersion
MiniProgram.prototype.checkVersion = async function () {
  const info = await this.send('Tool.getInfo')
  if (info.SDKVersion !== 'development') await originalVersionCheck.call(this)
}
const timeout = setTimeout(() => { console.error('微信模拟器测试超过 120 秒'); process.exit(1) }, 120000)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function main() {
  const miniProgram = await automator.connect({ wsEndpoint: `ws://127.0.0.1:${process.env.BERRY_AUTOMATION_PORT || 9420}` })
  const errors = []
  miniProgram.on('exception', error => errors.push(error))
  // glass-easel 热更新后旧测试库的 Page 句柄可能失效，始终从逻辑层取得当前页。
  const call = (method, ...args) => miniProgram.evaluate((name, params) => {
    const pages = getCurrentPages()
    const page = pages[pages.length - 1]
    return page[name].apply(page, params)
  }, method, args)
  const data = key => miniProgram.evaluate(name => {
    const pages = getCurrentPages()
    return pages[pages.length - 1].data[name]
  }, key)
  const tab = async url => {
    await miniProgram.callWxMethod('switchTab', { url })
    await sleep(600)
  }
  const artifacts = fs.mkdtempSync(path.join(os.tmpdir(), 'pinlan-ui-'))
  const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '../artifacts/device-inference-fixture.json'), 'utf8'))
  try {
    await tab('/pages/index/index')
    await call('reset')
    await sleep(500)
    await miniProgram.pageScrollTo(0)
    await sleep(300)
    await miniProgram.screenshot({ path: path.join(artifacts, 'home.png') })
    // The simulator is not a phone. Check the real production message first.
    await call('useSample')
    await sleep(500)
    assert.equal(await data('stage'), 'error')
    assert.match(await data('error'), /手机微信/)
    assert.ok((await data('imagePath')).includes('/blueberry-sample.jpg'))
    await call('reset')
    // Only the native device/session APIs are replaced. Model assembly, image
    // preprocessing and all UI/postprocessing still execute in WeChat itself.
    await miniProgram.evaluate(output => {
      wx.__berryDeviceInfo = wx.getDeviceInfo
      wx.__berryInference = wx.createInferenceSession
      wx.getDeviceInfo = () => ({ platform: 'ios' })
      wx.createInferenceSession = () => ({
        onLoad(callback) { setTimeout(callback, 10) }, onError() {}, destroy() {},
        run(inputs) {
          if (inputs.images.data.byteLength !== 3 * 640 * 640 * 4) throw new Error('input shape mismatch')
          return Promise.resolve({ output0: { type: 'float32', shape: output.shape, data: new Float32Array(output.values).buffer } })
        }
      })
    }, fixture)
    console.log('首页与模拟器提示通过，开始真实分包/画布及桌面 ONNX fixture 测试')
    await call('useSample')
    await sleep(300)
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && await data('stage') === 'loading') await sleep(300)
    assert.equal(await data('stage'), 'result', await data('error'))
    const result = await data('result')
    assert.ok(result.summary.total > 1)
    assert.equal(result.summary.total, result.summary.mature + result.summary.immature)
    await sleep(500)
    await miniProgram.screenshot({ path: path.join(artifacts, 'result.png') })
    await call('setFilter', { currentTarget: { dataset: { filter: 'mature' } } })
    assert.equal((await data('boxes')).length, result.summary.mature)
    await call('setFilter', { currentTarget: { dataset: { filter: 'immature' } } })
    assert.equal((await data('boxes')).length, result.summary.immature)
    await call('setFilter', { currentTarget: { dataset: { filter: 'all' } } })
    const exported = await call('renderAnnotatedImage')
    assert.ok(exported)
    console.log('真实分包加载、画布预处理、结果筛选和画布导出通过；原生会话使用桌面 ONNX fixture')
    await tab('/pages/records/records')
    const records = await data('records')
    assert.ok(records.length > 0)
    await miniProgram.screenshot({ path: path.join(artifacts, 'records.png') })
    await call('openRecord', { currentTarget: { dataset: { id: records[0].id } } })
    await sleep(500)
    assert.equal(await data('stage'), 'result')
    await tab('/pages/guide/guide')
    await miniProgram.screenshot({ path: path.join(artifacts, 'guide.png') })
    await tab('/pages/index/index')
    await call('reset')
    await miniProgram.pageScrollTo(0)
    await sleep(300)
    assert.deepEqual(errors, [])
    const output = path.join(__dirname, '../artifacts')
    await miniProgram.evaluate(() => {
      wx.getDeviceInfo = wx.__berryDeviceInfo
      wx.createInferenceSession = wx.__berryInference
      delete wx.__berryDeviceInfo
      delete wx.__berryInference
    })
    await miniProgram.disconnect()
    fs.mkdirSync(output, { recursive: true })
    for (const file of fs.readdirSync(artifacts)) fs.copyFileSync(path.join(artifacts, file), path.join(output, file))
    console.log(JSON.stringify({ passed: true, summary: result.summary, exportCanvas: Boolean(exported), screenshots: output }))
  } finally {
    try {
      await miniProgram.evaluate(() => {
        if (wx.__berryDeviceInfo) wx.getDeviceInfo = wx.__berryDeviceInfo
        if (wx.__berryInference) wx.createInferenceSession = wx.__berryInference
        delete wx.__berryDeviceInfo
        delete wx.__berryInference
      })
    } catch (_) {}
    miniProgram.disconnect(); clearTimeout(timeout)
  }
}
main().catch(error => { console.error(error); clearTimeout(timeout); process.exit(1) })
