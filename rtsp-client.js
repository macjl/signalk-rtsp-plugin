const net = require('net')
const crypto = require('crypto')
const { URL } = require('url')

// RTP/H264 depacketizer — reassembles NAL units from RTP packets
class H264Depacketizer {
  constructor (onNal) {
    this.onNal = onNal
    this.fuBuffer = null
  }

  process (rtp) {
    if (rtp.length < 12) return
    const payload = rtp.slice(12 + (rtp[0] & 0x0f) * 4)
    if (payload.length === 0) return

    const nalType = payload[0] & 0x1f

    if (nalType >= 1 && nalType <= 23) {
      // Single NAL unit
      this._emit(payload)
    } else if (nalType === 28) {
      // FU-A fragmented unit
      this._handleFuA(payload)
    } else if (nalType === 24) {
      // STAP-A — multiple NAL units in one packet
      let offset = 1
      while (offset + 2 < payload.length) {
        const size = payload.readUInt16BE(offset)
        offset += 2
        if (offset + size > payload.length) break
        this._emit(payload.slice(offset, offset + size))
        offset += size
      }
    }
  }

  _handleFuA (payload) {
    const fuHeader = payload[1]
    const startBit = (fuHeader & 0x80) !== 0
    const endBit = (fuHeader & 0x40) !== 0
    const nalType = fuHeader & 0x1f

    if (startBit) {
      // Reconstruct NAL header: forbidden_zero(1) | nal_ref_idc(2) | nal_unit_type(5)
      const nalHeader = (payload[0] & 0xe0) | nalType
      this.fuBuffer = Buffer.concat([Buffer.from([nalHeader]), payload.slice(2)])
    } else if (this.fuBuffer) {
      this.fuBuffer = Buffer.concat([this.fuBuffer, payload.slice(2)])
    }

    if (endBit && this.fuBuffer) {
      this._emit(this.fuBuffer)
      this.fuBuffer = null
    }
  }

  _emit (nalUnit) {
    // Wrap in Annex B start code: 0x00 0x00 0x00 0x01
    const annexB = Buffer.concat([Buffer.from([0, 0, 0, 1]), nalUnit])
    this.onNal(annexB)
  }
}

class RtspClient {
  constructor (url, { onNal, onError, debug }) {
    this.url = url
    this.onNal = onNal
    this.onError = onError
    this.debug = debug || (() => {})
    this.socket = null
    this.cseq = 0
    this.session = null
    this.depacketizer = new H264Depacketizer(onNal)
    this.recvBuffer = Buffer.alloc(0)
    this.state = 'idle'
    this.videoChannel = 0
    this.reconnectTimer = null
    this.stopped = false
  }

  start () {
    this.stopped = false
    this._connect()
  }

  stop () {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    if (this.socket) { this.socket.destroy(); this.socket = null }
  }

  _connect () {
    const parsed = new URL(this.url)
    const host = parsed.hostname
    const port = parseInt(parsed.port) || 554

    this.debug(`Connecting to ${host}:${port}`)
    this.socket = net.createConnection({ host, port })
    this.socket.setTimeout(10000)

    this.socket.on('connect', () => {
      this.debug('TCP connected, sending OPTIONS')
      this.state = 'options'
      this._sendRequest('OPTIONS', this.url)
    })

    this.socket.on('data', (data) => {
      this.recvBuffer = Buffer.concat([this.recvBuffer, data])
      this._processBuffer()
    })

    this.socket.on('error', (err) => {
      this.onError(err)
      this._scheduleReconnect()
    })

    this.socket.on('timeout', () => {
      this.debug('Socket timeout')
      this.socket.destroy()
      this._scheduleReconnect()
    })

    this.socket.on('close', () => {
      if (!this.stopped) {
        this.debug('Connection closed, reconnecting...')
        this._scheduleReconnect()
      }
    })
  }

  _scheduleReconnect () {
    if (this.stopped) return
    this.state = 'idle'
    this.session = null
    this.recvBuffer = Buffer.alloc(0)
    this.reconnectTimer = setTimeout(() => this._connect(), 5000)
  }

  _processBuffer () {
    while (this.recvBuffer.length > 0) {
      // Interleaved RTP: starts with $
      if (this.recvBuffer[0] === 0x24) {
        if (this.recvBuffer.length < 4) break
        const channel = this.recvBuffer[1]
        const length = this.recvBuffer.readUInt16BE(2)
        if (this.recvBuffer.length < 4 + length) break
        const rtpData = this.recvBuffer.slice(4, 4 + length)
        this.recvBuffer = this.recvBuffer.slice(4 + length)
        if (channel === this.videoChannel) {
          this.depacketizer.process(rtpData)
        }
        continue
      }

      // RTSP response: find end of headers
      const headerEnd = this.recvBuffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) break
      const headers = this.recvBuffer.slice(0, headerEnd + 4).toString()

      // Handle Content-Length body (e.g. SDP after DESCRIBE)
      const clMatch = headers.match(/[Cc]ontent-[Ll]ength:\s*(\d+)/)
      const contentLength = clMatch ? parseInt(clMatch[1]) : 0
      const totalLen = headerEnd + 4 + contentLength
      if (this.recvBuffer.length < totalLen) break

      const body = contentLength > 0
        ? this.recvBuffer.slice(headerEnd + 4, totalLen).toString()
        : ''
      this.recvBuffer = this.recvBuffer.slice(totalLen)
      this._handleResponse(headers, body)
    }
  }

  _handleResponse (responseHeaders, body = '') {
    const firstLine = responseHeaders.split('\r\n')[0]
    const statusCode = parseInt(firstLine.split(' ')[1])
    this.debug(`Response ${statusCode} in state ${this.state}`)

    if (statusCode === 401) {
      this._handleAuth(responseHeaders)
      return
    }

    if (statusCode < 200 || statusCode >= 300) {
      this.onError(new Error(`RTSP ${statusCode}: ${firstLine}`))
      return
    }

    const headers = this._parseHeaders(responseHeaders)
    if (headers['session']) {
      this.session = headers['session'].split(';')[0]
    }

    switch (this.state) {
      case 'options':
        this.state = 'describe'
        this._sendRequest('DESCRIBE', this.url, { Accept: 'application/sdp' })
        break

      case 'describe': {
        const trackUrl = this._parseVideoTrack(body)
        this.state = 'setup'
        this._sendRequest('SETUP', trackUrl, {
          Transport: 'RTP/AVP/TCP;unicast;interleaved=0-1',
        })
        break
      }

      case 'setup':
        this.state = 'play'
        this._sendRequest('PLAY', this.url, { Range: 'npt=0.000-' })
        break

      case 'play':
        this.state = 'streaming'
        this.debug('Streaming started')
        break
    }
  }

  _handleAuth (response) {
    const parsed = new URL(this.url)
    const wwwAuth = this._parseHeaders(response)['www-authenticate'] || ''

    if (wwwAuth.toLowerCase().startsWith('digest')) {
      const realm = (wwwAuth.match(/realm="([^"]+)"/) || [])[1] || ''
      const nonce = (wwwAuth.match(/nonce="([^"]+)"/) || [])[1] || ''
      const ha1 = crypto.createHash('md5').update(`${parsed.username}:${realm}:${parsed.password}`).digest('hex')
      const method = this._lastMethod
      const ha2 = crypto.createHash('md5').update(`${method}:${this.url}`).digest('hex')
      const digestResponse = crypto.createHash('md5').update(`${ha1}:${nonce}:${ha2}`).digest('hex')
      this._authHeader = `Digest username="${parsed.username}", realm="${realm}", nonce="${nonce}", uri="${this.url}", response="${digestResponse}"`
    } else {
      const creds = Buffer.from(`${parsed.username}:${parsed.password}`).toString('base64')
      this._authHeader = `Basic ${creds}`
    }

    // Replay last request with auth
    this._sendRequest(this._lastMethod, this._lastUrl, this._lastExtraHeaders)
  }

  _parseVideoTrack (sdp) {
    const lines = sdp.split('\n')
    let inVideo = false
    let control = ''
    for (const line of lines) {
      const l = line.trim()
      if (l.startsWith('m=video')) { inVideo = true; continue }
      if (l.startsWith('m=') && inVideo) break
      if (inVideo && l.startsWith('a=control:')) {
        control = l.slice('a=control:'.length)
      }
    }
    if (!control) return this.url
    if (control.startsWith('rtsp://')) return control
    return this.url.replace(/\/$/, '') + '/' + control
  }

  _parseHeaders (response) {
    const headers = {}
    const lines = response.split('\r\n').slice(1)
    for (const line of lines) {
      const idx = line.indexOf(':')
      if (idx > 0) {
        headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim()
      }
    }
    return headers
  }

  _sendRequest (method, url, extraHeaders = {}) {
    this._lastMethod = method
    this._lastUrl = url
    this._lastExtraHeaders = extraHeaders

    const headers = {
      CSeq: ++this.cseq,
      'User-Agent': 'SignalK-RTSP-Plugin/1.0',
      ...extraHeaders,
    }
    if (this.session) headers['Session'] = this.session
    if (this._authHeader) headers['Authorization'] = this._authHeader

    let req = `${method} ${url} RTSP/1.0\r\n`
    for (const [k, v] of Object.entries(headers)) {
      req += `${k}: ${v}\r\n`
    }
    req += '\r\n'
    this.debug(`> ${method} ${url}`)
    this.socket.write(req)
  }
}

module.exports = { RtspClient }
