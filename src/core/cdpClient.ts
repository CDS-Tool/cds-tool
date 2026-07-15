import { createConnection } from 'node:net'
import { EventEmitter } from 'node:events'

export interface CdpSession extends EventEmitter {
  send(command: string, params?: any): Promise<any>
  close(): void
}

export function inspectorConnect(wsUrl: string): Promise<CdpSession> {
  return new Promise((resolve, reject) => {
    const url = new URL(wsUrl)
    const port = parseInt(url.port, 10) || 9229
    const host = url.hostname || '127.0.0.1'
    const path = url.pathname || '/'

    const sock = createConnection(port, host, () => {
      // WebSocket handshake
      const key = Buffer.from(Math.random().toString(36).slice(2)).toString('base64')
      const req = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}:${port}`,
        `Upgrade: websocket`,
        `Connection: Upgrade`,
        `Sec-WebSocket-Key: ${key}`,
        `Sec-WebSocket-Version: 13`,
        ``, ``
      ].join('\r\n')
      sock.write(req)
    })

    const emitter = new EventEmitter()
    let buf = ''
    let handshakeDone = false
    let msgId = 0
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
    let closed = false

    sock.on('data', (data: Buffer) => {
      if (!handshakeDone) {
        buf += data.toString()
        if (buf.includes('\r\n\r\n')) {
          const headers = buf.slice(0, buf.indexOf('\r\n\r\n'))
          if (!headers.includes('101')) {
            sock.destroy()
            reject(new Error('WebSocket handshake failed'))
            return
          }
          handshakeDone = true
          buf = buf.slice(buf.indexOf('\r\n\r\n') + 4)
          // First message might be in the leftover buffer
          processFrame()
        }
        return
      }
      buf += data.toString('binary')
      processFrame()
    })

    function processFrame() {
      while (buf.length >= 2) {
        const firstByte = buf.charCodeAt(0)
        const secondByte = buf.charCodeAt(1)
        const opcode = firstByte & 0x0f
        const masked = (secondByte & 0x80) !== 0
        let payloadLen = secondByte & 0x7f
        let offset = 2

        if (payloadLen === 126) {
          if (buf.length < offset + 2) return
          payloadLen = (buf.charCodeAt(offset) << 8) | buf.charCodeAt(offset + 1)
          offset += 2
        } else if (payloadLen === 127) {
          if (buf.length < offset + 8) return
          payloadLen = 0
          for (let i = 0; i < 8; i++) payloadLen = (payloadLen << 8) | buf.charCodeAt(offset + i)
          offset += 8
        }

        let maskKey: number[] | null = null
        if (masked) {
          maskKey = []
          for (let i = 0; i < 4; i++) maskKey.push(buf.charCodeAt(offset + i))
          offset += 4
        }

        if (buf.length < offset + payloadLen) return

        let payload = ''
        for (let i = 0; i < payloadLen; i++) {
          const byte = buf.charCodeAt(offset + i)
          payload += String.fromCharCode(masked && maskKey ? byte ^ maskKey[i % 4] : byte)
        }

        buf = buf.slice(offset + payloadLen)

        if (opcode === 0x8) {
          // Close frame
          sock.destroy()
          return
        }
        if (opcode === 0x9) {
          // Ping - send pong
          sendFrame(0xa, Buffer.from(payload))
          continue
        }
        if (opcode === 0x2 || opcode === 0x1) {
          try {
            const obj = JSON.parse(payload)
            if (obj.id !== undefined) {
              const p = pending.get(obj.id)
              if (p) {
                pending.delete(obj.id)
                if (obj.error) p.reject(new Error(obj.error.message))
                else p.resolve(obj.result)
              }
            } else {
              emitter.emit('message', payload)
            }
          } catch {}
        }
      }
    }

    function sendFrame(opcode: number, data: Buffer) {
      const len = data.length
      let header: Buffer
      if (len < 126) {
        header = Buffer.alloc(2)
        header[0] = 0x80 | opcode
        header[1] = len
      } else if (len < 65536) {
        header = Buffer.alloc(4)
        header[0] = 0x80 | opcode
        header[1] = 126
        header.writeUInt16BE(len, 2)
      } else {
        header = Buffer.alloc(10)
        header[0] = 0x80 | opcode
        header[1] = 127
        header.writeBigUInt64BE(BigInt(len), 2)
      }
      sock.write(Buffer.concat([header, data]))
    }

    function sendCdp(method: string, params?: any): Promise<any> {
      return new Promise((resolve, reject) => {
        const id = ++msgId
        pending.set(id, { resolve, reject })
        const msg = JSON.stringify({ id, method, params: params || {} })
        sendFrame(0x1, Buffer.from(msg))
      })
    }

    const session: CdpSession = Object.assign(emitter, {
      send: sendCdp,
      close() {
        if (closed) return
        closed = true
        sendFrame(0x8, Buffer.from([0x03, 0xe8]))
        sock.destroy()
      },
    })

    sock.on('error', (err) => {
      if (!handshakeDone) reject(err)
      else emitter.emit('error', err)
    })

    sock.on('close', () => {
      closed = true
      for (const [, p] of pending) p.reject(new Error('Connection closed'))
      pending.clear()
    })

    // Wait a tiny bit for handshake to complete
    setTimeout(() => {
      if (handshakeDone) resolve(session)
    }, 100)
  })
}

export async function sendCdpCommand(session: CdpSession, method: string, params?: any): Promise<any> {
  return session.send(method, params)
}

export function netConnect(port: number, host = '127.0.0.1'): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = createConnection(port, host, () => resolve(sock))
    sock.on('error', reject)
  })
}
