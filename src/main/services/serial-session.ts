import { EventEmitter } from 'events'
import { SerialPort } from 'serialport'
import type { SerialDataBits, SerialParity, SerialStopBits } from '../../shared/types'
import {
  DEFAULT_SERIAL_BAUD_RATE,
  DEFAULT_SERIAL_DATA_BITS,
  DEFAULT_SERIAL_PARITY,
  DEFAULT_SERIAL_STOP_BITS,
} from '../../shared/types'

export interface SerialConnectOptions {
  path: string
  baudRate?: number
  dataBits?: SerialDataBits
  parity?: SerialParity
  stopBits?: SerialStopBits
}

/**
 * Interactive raw serial session for local COM ports.
 * Bytes are passed through as UTF-8 text with no Telnet IAC processing.
 */
export class SerialSession extends EventEmitter {
  private port: SerialPort | null = null
  private ended = false

  constructor(private readonly options: SerialConnectOptions) {
    super()
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.port) {
        reject(new Error('Serial session already connected'))
        return
      }

      const path = this.options.path?.trim()
      if (!path) {
        reject(new Error('Serial port path is required'))
        return
      }

      const baudRate =
        typeof this.options.baudRate === 'number' && this.options.baudRate > 0
          ? this.options.baudRate
          : DEFAULT_SERIAL_BAUD_RATE

      let port: SerialPort
      try {
        port = new SerialPort({
          path,
          baudRate,
          dataBits: this.options.dataBits ?? DEFAULT_SERIAL_DATA_BITS,
          parity: this.options.parity ?? DEFAULT_SERIAL_PARITY,
          stopBits: this.options.stopBits ?? DEFAULT_SERIAL_STOP_BITS,
          autoOpen: false,
        })
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)))
        return
      }

      this.port = port

      port.open(err => {
        if (err) {
          this.port = null
          try {
            port.close()
          } catch {
            /* ignore */
          }
          reject(err)
          return
        }
        resolve()
      })

      port.on('data', (chunk: Buffer) => {
        if (chunk.length === 0) return
        this.emit('data', chunk.toString('utf8'))
      })

      port.on('error', (err: Error) => {
        this.emit('error', err)
      })

      port.on('close', () => {
        if (this.ended) return
        this.ended = true
        this.port = null
        this.emit('close')
      })
    })
  }

  write(data: string | Buffer): void {
    if (!this.port || !this.port.isOpen) return
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
    try {
      this.port.write(buf)
    } catch {
      /* ignore */
    }
  }

  /** Serial has no window-size negotiation; kept for API parity with TelnetSession. */
  resize(_cols: number, _rows: number): void {
    /* no-op */
  }

  end(): void {
    if (this.ended) return
    this.ended = true
    const port = this.port
    this.port = null
    if (!port) return
    try {
      if (port.isOpen) {
        port.close()
      }
    } catch {
      try {
        port.destroy()
      } catch {
        /* ignore */
      }
    }
  }
}

export async function listSerialPorts(): Promise<
  { path: string; friendlyName?: string; manufacturer?: string }[]
> {
  const ports = await SerialPort.list()
  return ports.map(p => ({
    path: p.path,
    friendlyName: p.friendlyName || undefined,
    manufacturer: p.manufacturer || undefined,
  }))
}
