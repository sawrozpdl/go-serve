/**
 * Raw ESC/POS transport: open a TCP socket to <ip>:<port> (JetDirect / port
 * 9100), write the byte buffer, flush, close. Rejects on connect/timeout error
 * so callers can surface a clear "printer offline" message.
 */
import TcpSocket from 'react-native-tcp-socket';
import { Buffer } from 'buffer';

export function printBytes(
  host: string,
  port: number,
  bytes: Uint8Array,
  timeoutMs = 8000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      if (err) reject(err);
      else resolve();
    };

    const socket = TcpSocket.createConnection({ host, port }, () => {
      socket.write(Buffer.from(bytes) as unknown as string, undefined, () => {
        // Give the printer a beat to pull the bytes before we close.
        setTimeout(() => finish(), 150);
      });
    });
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => finish(new Error(`Printer ${host}:${port} timed out`)));
    socket.on('error', (e: unknown) =>
      finish(e instanceof Error ? e : new Error(`Printer ${host}:${port} error`)),
    );
  });
}

/**
 * Is something accepting connections at <host>:<port>? Opens a socket and
 * resolves true on connect, false on timeout/error — used by LAN discovery and
 * the printer-status indicator. A short timeout keeps a /24 subnet scan quick.
 */
export function probePrinter(host: string, port: number, timeoutMs = 1200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* already gone */
      }
      resolve(ok);
    };
    const socket = TcpSocket.createConnection({ host, port }, () => done(true));
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}
