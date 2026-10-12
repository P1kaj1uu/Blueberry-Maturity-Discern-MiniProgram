// getImageInfo may strip the initial slash from a code-package image path.
function absoluteImagePath(path) {
  if (!path || /^(?:\/|[a-z][a-z0-9+.-]*:)/i.test(path)) return path
  return '/' + path.replace(/^\.\//, '')
}

function sampleImage() {
  const target = `${wx.env.USER_DATA_PATH}/blueberry-sample.jpg`
  return new Promise((resolve, reject) => wx.getFileSystemManager().copyFile({
    srcPath: '/assets/blueberries.jpg', destPath: target,
    success: () => resolve(target), fail: reject
  }))
}

module.exports = { absoluteImagePath, sampleImage }
