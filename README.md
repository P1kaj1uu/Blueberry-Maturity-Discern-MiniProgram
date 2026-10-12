# 蓝莓成熟度识别

使用 `model/best.pt` 的微信原生小程序，支持拍照、相册选择、多颗蓝莓位置标注、成熟 / 未成熟判断、数量统计、成熟果占比、标注图保存和本机历史记录。界面沿用奶油白、深绿和真实果园照片。

## 没有服务器怎么用

**默认已经改为手机本地识别，无需启动 Python 服务、购买服务器、开通云开发或配置接口域名。** 模型从原始 `best.pt` 转成静态 ONNX，由微信官方 `wx.createInferenceSession` 在手机内执行；照片与记录留在当前设备。没有自动上传照片的兜底逻辑。

1. 用微信开发者工具导入本项目根目录 `Blueberry-Maturity-Discern-MiniProgram`，不要只导入 `miniprogram`。基础库选择 3.17.4 或更高，手机微信更新到近期版本。
2. 点击「清缓存 → 全部清除」，再重新编译。新增文件或分包未生效时，关闭项目后重新导入。
3. 保持 `miniprogram/config.js` 的 `inferenceMode: 'local'`。
4. 点击「预览」，用手机微信扫码。预览和发布都由微信承载小程序代码包；**生成预览码会把包含模型分包的代码上传到微信**。
5. 手机首页选择「试试示例」、拍照或相册照片。首次识别需要联网加载约 16MB 模型分包并校验文件，之后使用设备缓存；首次启动模型也会花费一些时间。

本地识别以手机为运行目标。电脑模拟器显示「本地识别需要在手机微信中运行」是预期提示；它不等于服务器连接失败。部分旧微信或手机推理引擎可能无法加载此模型，小程序会显示错误而不会伪造结果。**本项目已验证桌面 ONNX 推理与前端流程，尚未验证你的实际手机推理引擎。** 如果手机提示模型无法加载，请提供手机型号、微信版本和真机调试控制台的 `Blueberry inference initialization failed` 日志。

## 图片路径修复

首页与拍摄指南使用相对于各页面的 `../../assets/blueberries.jpg`。示例图先复制到微信用户文件目录再识别，不再把 `getImageInfo` 返回的 `assets/blueberries.jpg` 直接交给页面。后者会被解析成 `/pages/index/assets/blueberries.jpg`，造成之前的 500 / 图片不显示。路径工具同时兼容代码包绝对路径与 `wxfile://` 临时路径。

## 模型与分包

- 原始权重 `model/best.pt` 保持原文件；实际类别是 `0: Immature → 未成熟`、`1: Mature → 成熟`。
- `model/best.onnx`：float32、opset 11、固定输入 `images: [1,3,640,640]`，输出 `output0: [1,6,8400]`，没有额外量化。
- 模型约 12.3MB，以 base64 JS 文件拆成 12 个普通分包，通过微信 `require.async` 异步读取、解码和拼接，在运行前校验完整文件 MD5。
- 主包约 0.4MB，最大单分包约 1.4MB，总源文件约 16.8MB，低于主包 / 单分包 2MB 和总包限制。`miniprogram/models/` 是运行必需文件，不要删除或加入打包忽略列表。
- 手机画布将解码后的照片规范化，最长边不超过 1920px。显示图和检测坐标使用同一方向与尺寸；输入等比缩放至 640px 并补边，RGB / NCHW / 0–1 归一化。跨类别 NMS 阈值 0.45，默认置信度 0.25，最多 1000 个目标。
- 成熟果占比 = 成熟数量 ÷ 检测总数 × 100%，保留一位小数。未检出时总数和占比为 0。

检测结果取决于现有权重，光线、遮挡和叶片背景可能造成漏检或误检；模型置信度不是成熟百分比。应使用自有果园照片核验效果。历史最多保留 30 条，删除记录会删除对应本机照片。

## 验证与重新生成模型

普通使用不需要 Python。仅更换权重或验证模型时执行：

```sh
.venv/bin/python -m pip install -r server/requirements.txt -r scripts/requirements-model.txt
YOLO_CONFIG_DIR=.runtime/ultralytics .venv/bin/python scripts/build_device_model.py
YOLO_CONFIG_DIR=.runtime/ultralytics .venv/bin/python scripts/verify_device_model.py
npm install
npm test
```

重新生成脚本会更新 ONNX、模型分包、清单和 `app.json` 分包配置；目前要求权重仍为上述两类。

已通过 10 项 Node 测试，覆盖图片路径、输入通道、去补边、跨类别去重、统计、真实分包拼接和校验、缓存、取消后重试、模型初始化超时、模拟器提示及页面迟到响应。验证脚本对同一输入比对 ONNX 与原始 PyTorch 张量，并比对 JS 后处理与 Ultralytics 检测框及类别；本次最大张量误差约 0.00032。报告在 `artifacts/device-model-verification.json`。桌面生成的推理 fixture 只用于 UI 测试，不会进入小程序包或生产识别流程。

本机模拟器 UI 测试命令：

```sh
/Applications/wechatwebdevtools.app/Contents/MacOS/cli auto --project "$PWD" --auto-port 9420 --trust-project
npm run test:ui
```

UI 测试用桌面真实模型输出替代手机原生推理会话，验证实际分包加载、照片画布、结果页、类别筛选、记录和标注图导出；**不代表已经完成真机推理验证**。

## 可选的服务端调试

保留 `server/` 供开发者工具或已有服务器使用。需要时将 `inferenceMode` 改为 `'server'`，启动：

```sh
.venv/bin/python -m pip install -r server/requirements.txt
.venv/bin/python -m uvicorn server.app:app --host 0.0.0.0 --port 8000
```

服务地址在 `miniprogram/config.js` 的 `apiBaseUrl`，默认 `http://127.0.0.1:8000`，仅电脑本机可用。手机服务端调试需填写电脑局域网地址并保持电脑服务在线；公开的服务端模式需 HTTPS 合法域名。**默认 local 模式不读取该地址，也不调用 `/api/detect`。**

## 参考

端侧推理：[微信官方 API](https://developers.weixin.qq.com/miniprogram/dev/api/ai/inference/wx.createInferenceSession.html)、[使用指南](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/tutorial.html)、[算子支持列表](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/inference/supports.html)、[分包异步化](https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages/async.html)、[分包大小限制](https://developers.weixin.qq.com/miniprogram/dev/framework/subpackages.html)。模型转换：[Ultralytics ONNX 文档](https://docs.ultralytics.com/integrations/onnx/)。原始界面照片来源：Arinal Haq Izzawati Nurrahma / [Unsplash](https://unsplash.com/photos/ripe-and-unripe-blueberries-on-a-leafy-branch-kUvF4EPapAw)，按 [Unsplash License](https://unsplash.com/license) 使用；当前资产以项目 `assets/blueberries.jpg` 为准。
