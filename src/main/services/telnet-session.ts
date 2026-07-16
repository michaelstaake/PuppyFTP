import { EventEmitter } from 'events'
import net from 'net'

const IAC = 255
const DONT = 254
const DO = 253
const WONT = 252
const WILL = 251
const SB = 250
const SE = 240

const OPT_ECHO = 1
const OPT_SGA = 3
const OPT_TTYPE = 24
const OPT_NAWS = 31

const TTYPE_IS = 0
const TTYPE_SEND = 1

export interface TelnetConnectOptions {
  host: string
  port: number
  timeoutMs?: number
  cols?: number
  rows?: number
  terminalType?: string
}

/**
 * Interactive Telnet session over a raw TCP socket with minimal IAC negotiation
 * (Echo, Suppress Go Ahead, Terminal Type, NAWS).
 */
export class TelnetSession extends EventEmitter {
  private socket: net.Socket | null = null
  private parseState: 'data' | 'iac' | 'negotiate' | 'sb' | 'sb-iac' = 'data'
  private negotiateCmd = 0
  private sbBytes: number[] = []
  private cols: number
  private rows: number
  private terminalType: string
  private nawsEnabled = false
  private ended = false

  constructor(private readonly options: TelnetConnectOptions) {
    super()
    this.cols = Math.max(1, options.cols ?? 80)
    this.rows = Math.max(1, options.rows ?? 24)
    this.terminalType = options.terminalType || 'xterm-256color'
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) {
        reject(new Error('Telnet session already connected'))
        return
      }

      const socket = net.connect({
        host: this.options.host,
        port: this.options.port,
      })
      this.socket = socket

      let settled = false
      const timeoutMs =
        typeof this.options.timeoutMs === 'number' && this.options.timeoutMs > 0
          ? this.options.timeoutMs
          : 30000

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        socket.destroy()
        this.socket = null
        reject(new Error(`Telnet connection timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      const fail = (err: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.socket = null
        try {
          socket.destroy()
        } catch {
          /* ignore */
        }
        reject(err)
      }

      socket.once('connect', () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      })

      socket.on('data', (chunk: Buffer) => {
        this.onSocketData(chunk)
      })

      socket.on('error', (err: Error) => {
        if (!settled) {
          fail(err)
          return
        }
        this.emit('error', err)
      })

      socket.on('close', () => {
        if (this.ended) return
        this.ended = true
        this.socket = null
        this.emit('close')
      })
    })
  }

  write(data: string | Buffer): void {
    if (!this.socket || this.socket.destroyed) return
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    this.socket.write(escapeIac(buf))
  }

  resize(cols: number, rows: number): void {
    this.cols = Math.max(1, Math.floor(cols) || 80)
    this.rows = Math.max(1, Math.floor(rows) || 24)
    if (this.nawsEnabled) {
      this.sendNaws()
    }
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const socket = this.socket
    this.socket = null
    if (!socket) return
    try {
      socket.end()
    } catch {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
  }

  private onSocketData(chunk: Buffer): void {
    const textChunks: number[] = []

    for (let i = 0; i < chunk.length; i++) {
      const b = chunk[i]!

      switch (this.parseState) {
        case 'data':
          if (b === IAC) {
            this.parseState = 'iac'
          } else {
            textChunks.push(b)
          }
          break

        case 'iac':
          if (b === IAC) {
            // Escaped 0xFF in data stream
            textChunks.push(IAC)
            this.parseState = 'data'
          } else if (b === DO || b === DONT || b === WILL || b === WONT) {
            this.negotiateCmd = b
            this.parseState = 'negotiate'
          } else if (b === SB) {
            this.sbBytes = []
            this.parseState = 'sb'
          } else {
            // Ignore other IAC commands (GA, NOP, etc.)
            this.parseState = 'data'
          }
          break

        case 'negotiate':
          this.handleNegotiate(this.negotiateCmd, b)
          this.parseState = 'data'
          break

        case 'sb':
          if (b === IAC) {
            this.parseState = 'sb-iac'
          } else {
            this.sbBytes.push(b)
          }
          break

        case 'sb-iac':
          if (b === SE) {
            this.handleSubnegotiation(Buffer.from(this.sbBytes))
            this.sbBytes = []
            this.parseState = 'data'
          } else if (b === IAC) {
            this.sbBytes.push(IAC)
            this.parseState = 'sb'
          } else {
            this.sbBytes.push(b)
            this.parseState = 'sb'
          }
          break
      }
    }

    if (textChunks.length > 0) {
      this.emit('data', Buffer.from(textChunks).toString('utf8'))
    }
  }

  private handleNegotiate(cmd: number, option: number): void {
    switch (option) {
      case OPT_ECHO:
      case OPT_SGA:
        if (cmd === DO) this.sendCommand(WILL, option)
        else if (cmd === DONT) this.sendCommand(WONT, option)
        else if (cmd === WILL) this.sendCommand(DO, option)
        else if (cmd === WONT) this.sendCommand(DONT, option)
        break

      case OPT_TTYPE:
        if (cmd === DO) this.sendCommand(WILL, OPT_TTYPE)
        else if (cmd === DONT) this.sendCommand(WONT, OPT_TTYPE)
        else if (cmd === WILL) this.sendCommand(DONT, OPT_TTYPE)
        else if (cmd === WONT) {
          /* ignore */
        }
        break

      case OPT_NAWS:
        if (cmd === DO) {
          this.nawsEnabled = true
          this.sendCommand(WILL, OPT_NAWS)
          this.sendNaws()
        } else if (cmd === DONT) {
          this.nawsEnabled = false
          this.sendCommand(WONT, OPT_NAWS)
        } else if (cmd === WILL) {
          this.sendCommand(DONT, OPT_NAWS)
        } else if (cmd === WONT) {
          this.nawsEnabled = false
        }
        break

      default:
        // Refuse unknown options
        if (cmd === DO) this.sendCommand(WONT, option)
        else if (cmd === WILL) this.sendCommand(DONT, option)
        break
    }
  }

  private handleSubnegotiation(payload: Buffer): void {
    if (payload.length < 1) return
    const option = payload[0]!

    if (option === OPT_TTYPE && payload.length >= 2 && payload[1] === TTYPE_SEND) {
      const typeBuf = Buffer.from(this.terminalType, 'ascii')
      const out = Buffer.concat([
        Buffer.from([IAC, SB, OPT_TTYPE, TTYPE_IS]),
        typeBuf,
        Buffer.from([IAC, SE]),
      ])
      this.rawWrite(out)
    }
  }

  private sendNaws(): void {
    const w = Math.min(65535, this.cols)
    const h = Math.min(65535, this.rows)
    const dims = Buffer.from([(w >> 8) & 0xff, w & 0xff, (h >> 8) & 0xff, h & 0xff])
    const out = Buffer.concat([
      Buffer.from([IAC, SB, OPT_NAWS]),
      escapeIac(dims),
      Buffer.from([IAC, SE]),
    ])
    this.rawWrite(out)
  }

  private sendCommand(cmd: number, option: number): void {
    this.rawWrite(Buffer.from([IAC, cmd, option]))
  }

  private rawWrite(buf: Buffer): void {
    if (!this.socket || this.socket.destroyed) return
    try {
      this.socket.write(buf)
    } catch {
      /* ignore */
    }
  }
}

function escapeIac(buf: Buffer): Buffer {
  let needsEscape = false
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === IAC) {
      needsEscape = true
      break
    }
  }
  if (!needsEscape) return buf

  const out: number[] = []
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!
    out.push(b)
    if (b === IAC) out.push(IAC)
  }
  return Buffer.from(out)
}
