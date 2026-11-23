# Publishing a release / 发布版本

发布前运行 README 中的前后端检查，更新两份 README、Compose 和发布说明中的版本号。只发布已验证的 Linux amd64 镜像；不要把 `.env`、SQLite、运行日志或镜像 tar 提交到源码仓库。

Run the checks in the README, then update the version in both READMEs, Compose files and release notes. Publish a validated Linux amd64 image. Keep `.env`, SQLite databases, runtime logs and image archives out of Git history.

## Build and export / 构建与导出

在仓库根目录执行 / Run from the repository root:

```sh
version=2026.11.23
image="ghcr.io/haoranxu1989/network-rb5009:$version"
build_dir=$(mktemp -d)
trap 'rm -rf "$build_dir"' EXIT
docker buildx build --platform linux/amd64 --provenance=false --tag "$image" \
  --output "type=docker,compression=gzip,force-compression=true,dest=$build_dir/image.tar" .
python3 qnap/classic_archive.py "$build_dir/image.tar" \
  "qnap/network-rb5009-$version-linux-amd64.tar"
docker load -i "qnap/network-rb5009-$version-linux-amd64.tar"
(cd qnap && shasum -a 256 "network-rb5009-$version-linux-amd64.tar" > SHA256SUMS)
```

在 GitHub 创建 `v2026.11.23` Release，附上对应的 tar、`SHA256SUMS` 和中英文发布说明。tar 使用传统 Docker 格式，保留 QNAP 导入所需的 `repositories` 索引。

Create a GitHub Release named `v2026.11.23` with the tar, `SHA256SUMS` and bilingual release notes. The tar uses Docker's classic format, including the `repositories` index needed by QNAP import.

## Publish to GHCR / 发布镜像

打开 Actions → **Publish release image** → Run workflow，填写不带 `v` 的版本号。工作流下载 Release 中的 tar，校验 SHA-256，然后将**同一个镜像**推送到 GHCR 的版本标签和 `latest`，无需另存长期 Token。

Open Actions → **Publish release image** → Run workflow and enter the version without `v`. The workflow verifies and publishes the **same image** from the Release tar to the version tag and `latest`, using the temporary `GITHUB_TOKEN` instead of a separate long-lived credential.

首次发布后，在 GitHub Packages 的镜像设置中确认可见性为 **Public**，再以未登录状态核对镜像可拉取、Release 附件可下载。后续版本也应核对远端镜像摘要和离线包的一致性。

After the first publish, confirm **Public** visibility in the package settings and verify anonymous image pulls and Release downloads. For subsequent versions, verify that the remote image matches the offline archive as well.

交付完成后清理临时构建文件和测试容器，本地只保留最新镜像与 tar；已发布的历史 Release 保留供使用者回退。

After delivery, remove temporary build files and test containers; retain only the latest local image and tar. Keep public release history available for users who need to roll back.
