'use strict'

// No require() needed — fetch() is global in Node.js ≥ 18.

const FFMPEG_PORT = 8090

module.exports = function (app) {
  const plugin = {
    id:          'signalk-rtsp-plugin',
    name:        'RTSP Stream Viewer',
    description: 'Displays an RTSP stream via fmp4/MSE using signalk-container + ffmpeg',
  }

  plugin.schema = {
    type: 'object',
    required: ['rtspUrl'],
    properties: {
      rtspUrl: {
        type:    'string',
        title:   'RTSP Stream URL',
        default: 'rtsp://user:password@192.168.1.100:554/stream',
      },
      ffmpegImage: {
        type:    'string',
        title:   'FFmpeg Docker image',
        default: 'linuxserver/ffmpeg',
      },
      ffmpegTag: {
        type:    'string',
        title:   'FFmpeg Docker image tag',
        default: 'latest',
      },
      videoCodec: {
        type:        'string',
        title:       'MSE video codec string',
        default:     'avc1.64001F',
        description: 'Passed to MediaSource.addSourceBuffer(). avc1.64001F = H.264 High 3.1 (most IP cameras).',
      },
    },
  }

  // ── State ──────────────────────────────────────────────────────────────────
  let currentOptions = {}
  let stopped        = false
  let currentReader  = null   // ReadableStreamDefaultReader from fetch()

  // Browser clients currently receiving the fmp4 stream (Express res objects).
  const clients = new Set()

  // Initialization segment: everything before the first `moof` box.
  // Sent to new clients so they can start decoding mid-stream.
  let initSegment = null
  let initChunks  = []     // accumulates bytes until moof is found
  let initDone    = false

  // ── Express routes ─────────────────────────────────────────────────────────
  plugin.registerWithRouter = function (router) {
    router.get('/player', (req, res) => {
      const codec = currentOptions.videoCodec || 'avc1.64001F'
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(playerHtml(codec))
    })

    // fmp4 stream — keep connection open and push chunks.
    // New clients receive the cached init segment first.
    router.get('/stream', (req, res) => {
      res.setHeader('Content-Type', 'video/mp4')
      res.setHeader('Cache-Control', 'no-cache, no-store')
      if (initSegment) res.write(initSegment)
      clients.add(res)
      app.debug(`fmp4 client connected (${clients.size} total)`)
      req.on('close', () => {
        clients.delete(res)
        app.debug(`fmp4 client disconnected (${clients.size} total)`)
      })
    })
  }

  // ── Plugin lifecycle ───────────────────────────────────────────────────────
  plugin.start = function (options) {
    currentOptions = options || {}
    stopped        = false
    asyncStart(currentOptions).catch(err => app.error(err.message))
  }

  async function asyncStart (options) {
    const rtspUrl = options.rtspUrl     || 'rtsp://user:password@192.168.1.100:554/stream'
    const image   = options.ffmpegImage || 'linuxserver/ffmpeg'
    const tag     = options.ffmpegTag   || 'latest'

    app.debug('Waiting for signalk-container manager…')
    const mgr = await waitForManager()

    if (typeof mgr.resolveContainerAddress !== 'function') {
      throw new Error('signalk-container >= 0.2.1 is required — please update it in Plugin Config')
    }

    app.debug('Container manager ready, starting ffmpeg…')

    await mgr.ensureRunning('rtsp-to-fmp4', {
      image,
      tag,
      signalkAccessiblePorts: [FFMPEG_PORT],
      restart: 'unless-stopped',
      command: [
        '-rtsp_transport', 'tcp',
        '-i', rtspUrl,
        '-c:v', 'copy',
        '-an',
        '-f', 'mp4',
        '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
        '-listen', '1',
        `http://0.0.0.0:${FFMPEG_PORT}`,
      ],
    })

    const addr = await mgr.resolveContainerAddress('rtsp-to-fmp4', FFMPEG_PORT)
    app.debug(`ffmpeg started — connecting to http://${addr}`)
    connectLoop(`http://${addr}`)
  }

  // ── FFmpeg HTTP client (uses global fetch — no require needed) ─────────────
  async function connectLoop (url) {
    if (stopped) return

    // Reset init segment state for this new connection.
    initSegment = null
    initChunks  = []
    initDone    = false

    try {
      const response = await fetch(url)
      if (!response.ok) {
        app.debug(`ffmpeg HTTP ${response.status}, retrying in 2s`)
        retry(url)
        return
      }
      app.debug('fmp4 stream connected')

      currentReader = response.body.getReader()
      while (true) {
        const { done, value } = await currentReader.read()
        if (done) break

        const chunk = Buffer.from(value)

        if (!initDone) {
          initChunks.push(chunk)
          const combined = Buffer.concat(initChunks)
          const pos = findMoofOffset(combined)
          if (pos >= 0) {
            initSegment = combined.subarray(0, pos)
            const rest  = combined.subarray(pos)
            initChunks  = []
            initDone    = true
            if (rest.length) broadcast(rest)
          }
        } else {
          broadcast(chunk)
        }
      }
      app.debug('fmp4 stream ended, retrying in 2s')
    } catch (e) {
      if (!stopped) app.debug(`ffmpeg connect error: ${e.message}`)
    }

    retry(url)
  }

  function broadcast (chunk) {
    for (const res of clients) res.write(chunk)
  }

  function retry (url) {
    if (stopped) return
    setTimeout(() => connectLoop(url), 2000)
  }

  plugin.stop = function () {
    stopped = true
    if (currentReader) { currentReader.cancel().catch(() => {}); currentReader = null }
    for (const res of clients) res.end()
    clients.clear()
    const mgr = globalThis.__signalk_containerManager
    if (mgr) mgr.stop('rtsp-to-fmp4').catch(() => {})
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  async function waitForManager (timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const mgr = globalThis.__signalk_containerManager
      if (mgr?.getRuntime()) return mgr
      await new Promise(r => setTimeout(r, 1000))
    }
    throw new Error('signalk-container unavailable after 30s — is the plugin installed and enabled?')
  }

  /**
   * Walk ISO base media boxes to find the byte offset of the first `moof`.
   * Each box: [4-byte BE size][4-byte ASCII type][...data]
   * Returns -1 if not found or buffer is truncated mid-box.
   */
  function findMoofOffset (buf) {
    let offset = 0
    while (offset + 8 <= buf.length) {
      const size = buf.readUInt32BE(offset)
      if (size < 8) break
      const type = buf.slice(offset + 4, offset + 8).toString('ascii')
      if (type === 'moof') return offset
      if (offset + size > buf.length) break  // incomplete — wait for more data
      offset += size
    }
    return -1
  }

  // ── Player HTML ────────────────────────────────────────────────────────────
  function playerHtml (codec) {
    const mime = `video/mp4; codecs="${codec}"`
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RTSP Stream</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0 }
  body { background: #000; display: flex; align-items: center; justify-content: center; height: 100vh }
  video { max-width: 100%; max-height: 100vh }
  #status { color: #fff; font: 12px/1 sans-serif; position: absolute; top: 8px; left: 8px;
            opacity: .7; background: rgba(0,0,0,.4); padding: 3px 6px; border-radius: 3px }
</style>
</head>
<body>
<video id="v" autoplay muted playsinline></video>
<div id="status">Connecting…</div>
<script>
const video  = document.getElementById('v')
const status = document.getElementById('status')
const MIME   = ${JSON.stringify(mime)}

function connect () {
  if (!MediaSource.isTypeSupported(MIME)) {
    status.textContent = 'Codec not supported: ' + MIME
    return
  }

  const ms = new MediaSource()
  video.src = URL.createObjectURL(ms)

  ms.addEventListener('sourceopen', () => {
    const sb    = ms.addSourceBuffer(MIME)
    sb.mode     = 'sequence'
    const queue = []
    let pending = false

    function flush () {
      if (pending || sb.updating || !queue.length) return
      pending = true
      try { sb.appendBuffer(queue.shift()) }
      catch (e) { queue.length = 0; pending = false }
    }

    sb.addEventListener('updateend', () => { pending = false; flush() })

    status.textContent = 'Fetching stream…'

    fetch('./stream')
      .then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        status.textContent = 'Live ●'
        const reader = r.body.getReader()
        ;(function read () {
          reader.read().then(({ done, value }) => {
            if (done) { status.textContent = 'Stream ended — reconnecting…'; setTimeout(connect, 2000); return }
            queue.push(value)
            flush()
            read()
          }).catch(() => { status.textContent = 'Stream error — reconnecting…'; setTimeout(connect, 2000) })
        })()
      })
      .catch(() => { status.textContent = 'Connection failed — retrying…'; setTimeout(connect, 2000) })
  })
}

connect()
</script>
</body>
</html>`
  }

  return plugin
}
