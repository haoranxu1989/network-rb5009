#!/usr/local/bin/python -I
"""Prepare the Network data mount before running the container as the service user."""
import os
import pwd
import stat
import sys
from pathlib import Path


PANEL = ["python", "-m", "network"]
DATA = Path("/data")


def ensure_writable(path, uid, *, directory=False):
    original = path.lstat()
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not expected_type(original.st_mode):
        raise ValueError(f"SQLite 路径类型异常，请检查 {path}")

    access = os.R_OK | os.W_OK
    if directory:
        access |= os.X_OK
    os.seteuid(uid)
    try:
        if os.access(path, access, effective_ids=True):
            return
    finally:
        os.seteuid(0)

    # Pin the inode so a renamed SQLite sidecar cannot redirect a permission change.
    flags = os.O_RDONLY | os.O_NOFOLLOW | (os.O_DIRECTORY if directory else os.O_NONBLOCK)
    fd = os.open(path, flags)
    try:
        current = os.fstat(fd)
        if not os.path.samestat(original, current) or (not directory and current.st_nlink != 1):
            raise ValueError(f"请在 NAS 上检查 {path} 的文件链接及写入权限")
        if current.st_uid != uid:
            os.fchown(fd, uid, -1)
        owner_access = 0o700 if directory else 0o600
        os.fchmod(fd, stat.S_IMODE(os.fstat(fd).st_mode) | owner_access)
    finally:
        os.close(fd)


def prepare_data(uid):
    ensure_writable(DATA, uid, directory=True)
    for suffix in ("", "-wal", "-shm", "-journal"):
        try:
            ensure_writable(DATA / ("network.sqlite3" + suffix), uid)
        except FileNotFoundError:
            # SQLite creates sidecars on demand and may remove them when it closes.
            continue


def main():
    command = sys.argv[1:] or PANEL
    if os.geteuid() == 0:
        account = pwd.getpwnam("network")
        # Preserve supplemental groups supplied by Docker for a shared data mount.
        groups = set(os.getgrouplist(account.pw_name, account.pw_gid))
        groups.update(group for group in os.getgroups() if group != 0)
        os.setgroups(sorted(groups))
        os.setgid(account.pw_gid)
        if command == PANEL and Path(os.getenv("NETWORK_DATA_DIR", "/data")) == DATA:
            try:
                prepare_data(account.pw_uid)
            except (OSError, ValueError) as error:
                raise SystemExit(f"无法准备 SQLite 数据目录 {DATA}，请检查读写挂载和权限。{error}") from None
        os.setuid(account.pw_uid)
        os.environ.update(HOME=account.pw_dir, USER=account.pw_name, LOGNAME=account.pw_name)
    os.execvp(command[0], command)


if __name__ == "__main__":
    main()
