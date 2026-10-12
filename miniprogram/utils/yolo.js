function letterbox(width, height, size = 640) {
  const scale = Math.min(size / width, size / height)
  const resizedWidth = Math.round(width * scale)
  const resizedHeight = Math.round(height * scale)
  return { width, height, size, resizedWidth, resizedHeight,
    left: Math.round((size - resizedWidth) / 2 - .1),
    top: Math.round((size - resizedHeight) / 2 - .1), scale }
}

function rgbaToTensor(rgba) {
  const pixels = rgba.length / 4
  const tensor = new Float32Array(pixels * 3)
  for (let i = 0; i < pixels; i++) {
    tensor[i] = rgba[i * 4] / 255
    tensor[pixels + i] = rgba[i * 4 + 1] / 255
    tensor[2 * pixels + i] = rgba[i * 4 + 2] / 255
  }
  return tensor
}

function iou(a, b) {
  const intersection = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
    Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]))
  const union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
  return union > 0 ? intersection / union : 0
}

function decode(output, transform, threshold = .25) {
  if (!output || output.type !== 'float32' || output.shape.length !== 3 ||
      output.shape[0] !== 1 || output.shape[1] !== 6 || !(output.data instanceof ArrayBuffer)) {
    throw new Error('模型输出格式不匹配，请重新预览小程序')
  }
  const values = new Float32Array(output.data)
  const count = output.shape[2]
  if (values.length !== 6 * count) throw new Error('模型输出数据不完整')
  const candidates = []
  for (let i = 0; i < count; i++) {
    const immature = values[4 * count + i], mature = values[5 * count + i]
    const confidence = Math.max(immature, mature)
    if (!Number.isFinite(confidence) || confidence < threshold) continue
    const cx = values[i], cy = values[count + i], w = values[2 * count + i], h = values[3 * count + i]
    const box = [(cx - w / 2 - transform.left) / transform.scale,
      (cy - h / 2 - transform.top) / transform.scale,
      (cx + w / 2 - transform.left) / transform.scale,
      (cy + h / 2 - transform.top) / transform.scale]
    if (!box.every(Number.isFinite) || box[2] <= box[0] || box[3] <= box[1]) continue
    const status = mature > immature ? 'mature' : 'immature'
    candidates.push({ box, confidence, status, label: status === 'mature' ? '成熟' : '未成熟' })
  }
  candidates.sort((a, b) => b.confidence - a.confidence)
  const detections = []
  for (const item of candidates) {
    // Class-agnostic NMS: one fruit contributes to exactly one category.
    if (detections.some(kept => iou(item.box, kept.box) > .45)) continue
    detections.push(Object.assign({ id: detections.length + 1 }, item))
    if (detections.length === 1000) break
  }
  // Clip after NMS, matching Ultralytics; clipping beforehand changes overlap at image edges.
  detections.forEach(item => {
    item.box = item.box.map((value, index) => Math.max(0, Math.min(index % 2 ? transform.height : transform.width, value)))
  })
  const mature = detections.filter(item => item.status === 'mature').length
  return { detections, summary: { total: detections.length, mature,
    immature: detections.length - mature,
    mature_ratio: detections.length ? Math.round(mature / detections.length * 1000) / 10 : 0 } }
}

module.exports = { letterbox, rgbaToTensor, decode }
