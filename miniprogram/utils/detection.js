// 后端坐标基于按 EXIF 方向纠正后的原图，使用百分比保持缩放时的位置一致。
function boxesForView(result, filter) {
  const width = result.image.width
  const height = result.image.height
  return result.detections.filter(item => filter === 'all' || item.status === filter).map(item => {
    const [x1, y1, x2, y2] = item.box
    return Object.assign({}, item, {
      confidenceLabel: Math.round(item.confidence * 100),
      style: `left:${x1 / width * 100}%;top:${y1 / height * 100}%;width:${(x2 - x1) / width * 100}%;height:${(y2 - y1) / height * 100}%;`
    })
  })
}

module.exports = { boxesForView }
