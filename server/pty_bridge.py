#!/usr/bin/env python3

import os
import pty
import select
import signal
import subprocess
import sys
import termios


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pty_bridge.py <command> [args...]", file=sys.stderr)
        return 2

    master_fd, slave_fd = pty.openpty()
    cols = int(os.environ.get("COLUMNS", "120"))
    rows = int(os.environ.get("LINES", "30"))
    termios.tcsetwinsize(slave_fd, (rows, cols))

    child = subprocess.Popen(
        sys.argv[1:],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        cwd=os.getcwd(),
        env=os.environ.copy(),
        start_new_session=True,
        close_fds=True,
    )
    os.close(slave_fd)

    stdin_fd = sys.stdin.fileno()
    stdout_fd = sys.stdout.fileno()

    def terminate(_signum, _frame):
        try:
            os.killpg(child.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)

    try:
        while True:
            ready, _, _ = select.select([master_fd, stdin_fd], [], [], 0.1)

            if master_fd in ready:
                try:
                    data = os.read(master_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    os.write(stdout_fd, data)

            if stdin_fd in ready:
                try:
                    data = os.read(stdin_fd, 65536)
                except OSError:
                    data = b""
                if data:
                    os.write(master_fd, data)

            result = child.poll()
            if result is not None:
                while True:
                    try:
                        data = os.read(master_fd, 65536)
                    except OSError:
                        break
                    if not data:
                        break
                    os.write(stdout_fd, data)
                return result
    finally:
        try:
            os.close(master_fd)
        except OSError:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
