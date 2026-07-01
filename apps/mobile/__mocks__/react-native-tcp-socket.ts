/**
 * Jest mock of react-native-tcp-socket. Captures written bytes on `__writes`
 * and simulates a successful connect+write so `printBytes` resolves.
 */
export const __writes: Uint8Array[] = [];

type Cb = (arg?: unknown) => void;

const socket = {
  on: (_ev: string, _cb: Cb) => socket,
  setTimeout: (_ms: number) => socket,
  write: (data: Uint8Array, _enc: unknown, cb?: Cb) => {
    __writes.push(data);
    cb?.();
    return true;
  },
  destroy: () => {},
};

export function __reset(): void {
  __writes.length = 0;
}

const TcpSocket = {
  createConnection: (_opts: { host: string; port: number }, onConnect?: Cb) => {
    setTimeout(() => onConnect?.(), 0);
    return socket;
  },
};

export default TcpSocket;
