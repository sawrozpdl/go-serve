/**
 * Raw ESC/POS transport: open a TCP socket to <ip>:<port> (JetDirect / port
 * 9100), write the byte buffer, flush, close. Rejects on connect/timeout error
 * so callers can surface a clear "printer offline" message.
 *
 * Close discipline: sockets that connected are closed with end() (FIN), never
 * destroy() (RST). Cheap single-socket printer firmware (e.g. SP-83xx) wedges
 * its whole network stack on an RST — the printer drops off the LAN until
 * power-cycled. destroy() is reserved for error/timeout paths and as a
 * delayed fallback when the FIN handshake stalls.
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

    // Once the payload is fully written the job has succeeded — a printer
    // that then stalls the FIN handshake must not surface as an error.
    let wrote = false;
    const socket = TcpSocket.createConnection({ host, port }, () => {
      socket.write(Buffer.from(bytes) as unknown as string, undefined, () => {
        wrote = true;
        // Give the printer a beat to pull the bytes, then close gracefully.
        setTimeout(() => {
          try {
            socket.end();
          } catch {
            finish();
          }
        }, 150);
      });
    });
    socket.setTimeout(timeoutMs);
    socket.on('close', () => finish());
    socket.on('timeout', () =>
      finish(wrote ? undefined : new Error(`Printer ${host}:${port} timed out`)),
    );
    socket.on('error', (e: unknown) =>
      finish(wrote ? undefined : e instanceof Error ? e : new Error(`Printer ${host}:${port} error`)),
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
      if (ok) {
        // Connected — close with FIN, and only destroy() later if the
        // handshake stalls (see file header: RST wedges printer firmware).
        try {
          socket.end();
        } catch {
          /* fall through to the delayed destroy */
        }
        setTimeout(() => {
          try {
            socket.destroy();
          } catch {
            /* already gone */
          }
        }, 500);
      } else {
        try {
          socket.destroy();
        } catch {
          /* already gone */
        }
      }
      resolve(ok);
    };
    const socket = TcpSocket.createConnection({ host, port }, () => done(true));
    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}
