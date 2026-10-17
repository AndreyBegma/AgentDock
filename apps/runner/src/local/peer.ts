import { dlopen, FFIType, ptr } from 'bun:ffi';

/** `getsockopt` levels and options: Linux `SO_PEERCRED`, macOS `LOCAL_PEERPID`. */
const LINUX_SOL_SOCKET = 1;
const LINUX_SO_PEERCRED = 17;
const DARWIN_SOL_LOCAL = 0;
const DARWIN_LOCAL_PEERPID = 0x002;

type GetSockOpt = (
  fd: number,
  level: number,
  option: number,
  value: ReturnType<typeof ptr>,
  length: ReturnType<typeof ptr>,
) => number;

let getsockopt: GetSockOpt | null | undefined;

const libc = (os: string): GetSockOpt | null => {
  if (getsockopt !== undefined) return getsockopt;
  try {
    const lib = dlopen(
      os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6',
      {
        getsockopt: {
          args: [
            FFIType.i32,
            FFIType.i32,
            FFIType.i32,
            FFIType.ptr,
            FFIType.ptr,
          ],
          returns: FFIType.i32,
        },
      },
    );
    getsockopt = lib.symbols.getsockopt as GetSockOpt;
  } catch {
    getsockopt = null;
  }
  return getsockopt;
};

/**
 * #113: the pid of the process at the other end of an accepted unix socket,
 * from the kernel — `SO_PEERCRED` on Linux, `LOCAL_PEERPID` on macOS. Null
 * where neither can be read; the caller then has the session token only.
 */
export const socketPeerPid = (
  fd: number | undefined,
  os: string = process.platform,
): number | null => {
  if (fd === undefined || fd < 0) return null;
  if (os !== 'linux' && os !== 'darwin') return null;
  const call = libc(os);
  if (!call) return null;
  try {
    if (os === 'linux') {
      // struct ucred { pid_t pid; uid_t uid; gid_t gid; }
      const cred = new Int32Array(3);
      const length = new Uint32Array([cred.byteLength]);
      const failed = call(
        fd,
        LINUX_SOL_SOCKET,
        LINUX_SO_PEERCRED,
        ptr(cred),
        ptr(length),
      );
      return failed === 0 && cred[0] > 0 ? cred[0] : null;
    }
    const pid = new Int32Array(1);
    const length = new Uint32Array([pid.byteLength]);
    const failed = call(
      fd,
      DARWIN_SOL_LOCAL,
      DARWIN_LOCAL_PEERPID,
      ptr(pid),
      ptr(length),
    );
    return failed === 0 && pid[0] > 0 ? pid[0] : null;
  } catch {
    return null;
  }
};
